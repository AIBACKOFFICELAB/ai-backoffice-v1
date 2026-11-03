import { bookingConfigProblem, type RevenueDeskConfig } from "./config";
import { isSlotWithinPolicy } from "./slots";
import { CalendarError, type CalendarFailure, type CalendarProvider } from "./calendar/types";
import type { CallerConfirmationStore } from "./confirmation";

export type BookingStatus = "pending" | "confirmed" | "conflict" | "failed" | "cancelled";
export type Booking = {
  id: string;
  tenantId: string;
  callId: string;
  leadId: string | null;
  idempotencyKey: string;
  calendarId: string;
  start: string;
  end: string;
  timezone: string;
  providerEventId: string | null;
  status: BookingStatus;
  failureCategory: string | null;
  updatedAt: string;
  leaseToken?: string;
};

export class SlotTakenError extends Error {}
export class CallAlreadyBookedError extends Error {}
/** Another request already inserted this exact idempotency key. */
export class BookingKeyConflictError extends Error {}

/** Maps a Postgres unique-violation message to the guard that fired. */
export function bookingUniqueViolation(message: string): SlotTakenError | CallAlreadyBookedError | BookingKeyConflictError | null {
  if (/live_slot/.test(message)) return new SlotTakenError();
  if (/live_per_call/.test(message)) return new CallAlreadyBookedError();
  if (/idempotency_key/.test(message)) return new BookingKeyConflictError();
  return null;
}

export interface BookingStore {
  findByIdempotencyKey(tenantId: string, key: string): Promise<Booking | null>;
  /** Throws SlotTakenError / CallAlreadyBookedError / BookingKeyConflictError on the DB unique guards. */
  insertPending(b: Omit<Booking, "id" | "providerEventId" | "status" | "failureCategory" | "updatedAt">): Promise<Booking>;
  /** Atomically takes over a pending row whose lease has expired by the
   * DATABASE clock; returns null while the lease is live or if another request won. */
  claimPending(tenantId: string, id: string, leaseSeconds: number): Promise<Booking | null>;
  update(tenantId: string, id: string, patch: Partial<Pick<Booking, "status" | "providerEventId" | "failureCategory">>, leaseToken?: string): Promise<Booking>;
}

export type BookingResult =
  | { confirmed: true; bookingId: string; providerEventId: string; start: string; end: string; timezone: string; deduped: boolean }
  | { confirmed: false; failure: CalendarFailure; bookingId: string | null; statusUnknown?: boolean; callAlreadyBooked?: boolean };

/** Call escalation_reason recording that the owner must confirm an appointment
 * the receptionist could not confirm (or rule out) during the call. */
export const BOOKING_CONFIRMATION_FOLLOW_UP = "booking_pending_confirmation";

/** A pending row younger than this (by the database clock) is presumed in flight on another request. */
export const PENDING_LEASE_MS = 45_000;

export function bookingIdempotencyKey(callId: string, start: string, durationMinutes: number) {
  return `rd-booking:${callId}:${new Date(start).toISOString()}:${durationMinutes}`;
}

/**
 * The ONE booking write path. Success requires provider confirmation AND a
 * post-write overlap check; until both pass, nothing is reported booked.
 * Retries never blindly insert a second event: they reconcile by the AIBO
 * booking id stored in the provider event's private extended properties.
 */
export async function bookAppointment(
  deps: { store: BookingStore; calendar: CalendarProvider; now?: () => Date; confirmations?: CallerConfirmationStore },
  req: { cfg: RevenueDeskConfig; callId: string; leadId: string | null; intakeRevision?: number; start: string; durationMinutes: number; callerConfirmed: boolean; summary: string }
): Promise<BookingResult> {
  const now = deps.now?.() ?? new Date();
  const { cfg } = req;
  if (req.callerConfirmed !== true) return { confirmed: false, failure: "INVALID_REQUEST", bookingId: null };
  if (bookingConfigProblem(cfg)) return { confirmed: false, failure: "CONFIGURATION_ERROR", bookingId: null };
  const calendarId = cfg.calendarId!;
  const startMs = Date.parse(req.start);
  if (!Number.isFinite(startMs) || !isSlotWithinPolicy(cfg, req.start, req.durationMinutes, now)) {
    return { confirmed: false, failure: "SLOT_UNAVAILABLE", bookingId: null };
  }
  const start = new Date(startMs).toISOString();
  const end = new Date(startMs + req.durationMinutes * 60000).toISOString();
  const key = bookingIdempotencyKey(req.callId, start, req.durationMinutes);

  let booking = await deps.store.findByIdempotencyKey(cfg.tenantId, key);
  if (booking) {
    return reconcileBooking(deps, booking);
  } else {
    // A model boolean is necessary for the old tool contract, never sufficient.
    // The live adapter has no independently trustworthy evidence source and
    // deliberately supplies no confirmation store. No row or event is created.
    const authorized = await deps.confirmations?.consume({ tenantId: cfg.tenantId, callId: req.callId, leadId: req.leadId,
      intakeRevision: req.intakeRevision ?? 0, calendarId, start, end, timezone: cfg.timezone, idempotencyKey: key }).catch(() => false);
    if (authorized !== true) return { confirmed: false, failure: "CONFIRMATION_UNAVAILABLE", bookingId: null };
    try {
      booking = await deps.store.insertPending({ tenantId: cfg.tenantId, callId: req.callId, leadId: req.leadId, idempotencyKey: key, calendarId, start, end, timezone: cfg.timezone });
    } catch (e) {
      if (!(e instanceof SlotTakenError || e instanceof CallAlreadyBookedError || e instanceof BookingKeyConflictError)) throw e;
      // A concurrent duplicate of THIS request may own the appointment (Postgres
      // may report any of the three unique guards). Answer from the
      // authoritative row; never take over a row another request just inserted.
      const winner = await deps.store.findByIdempotencyKey(cfg.tenantId, key);
      if (winner) {
        return reconcileBooking(deps, winner);
      }
      if (e instanceof SlotTakenError) return { confirmed: false, failure: "SLOT_UNAVAILABLE", bookingId: null };
      if (e instanceof CallAlreadyBookedError) return { confirmed: false, failure: "INVALID_REQUEST", bookingId: null, callAlreadyBooked: true };
      return pending(null);
    }
  }

  const buf = cfg.bufferMinutes * 60000;
  // 1. pre-write free/busy check
  try {
    const busy = await deps.calendar.getBusy(calendarId, new Date(startMs - buf).toISOString(), new Date(Date.parse(end) + buf).toISOString());
    if (busy.some((b) => Date.parse(b.start) < Date.parse(end) + buf && Date.parse(b.end) > startMs - buf)) {
      await deps.store.update(cfg.tenantId, booking.id, { status: "conflict", failureCategory: "SLOT_UNAVAILABLE" }, booking.leaseToken);
      return { confirmed: false, failure: "SLOT_UNAVAILABLE", bookingId: booking.id };
    }
  } catch (e) {
    const cat = e instanceof CalendarError ? e.category : "PROVIDER_ERROR";
    await deps.store.update(cfg.tenantId, booking.id, { status: "failed", failureCategory: cat }, booking.leaseToken);
    return { confirmed: false, failure: cat, bookingId: booking.id };
  }

  // 2. write
  let eventId: string;
  try {
    // Fence a worker that stalled during free/busy past lease takeover.
    await deps.store.update(cfg.tenantId, booking.id, { failureCategory: "WRITE_OUTCOME_UNKNOWN" }, booking.leaseToken);
    const ev = await deps.calendar.createEvent(calendarId, { aiboBookingId: booking.id, tenantId: cfg.tenantId, start, end, timezone: cfg.timezone, summary: req.summary });
    eventId = ev.eventId;
  } catch {
    // Outcome unknown (timeout after provider accepted?) -> reconcile, never re-insert blindly.
    const recovered = await safeFind(deps.calendar, calendarId, booking.id, start, end);
    if (recovered && recovered !== "error") {
      eventId = recovered.eventId;
    } else {
      // An empty lookup cannot exclude a delayed successful insert.
      await markUncertain(deps.store, booking, "WRITE_OUTCOME_UNKNOWN");
      return pending(booking.id);
    }
  }
  return finalize(deps, booking, eventId, start, end);
}

/**
 * Answers a duplicate from the existing row. Final states are authoritative;
 * A lease grants one bounded reconciliation pass, NEVER a second insertion.
 * Missing events remain unresolved even after expiry or process interruption.
 */
export async function reconcileBooking(
  deps: { store: BookingStore; calendar: CalendarProvider },
  booking: Booking
): Promise<BookingResult> {
  if (booking.status === "confirmed") return ok(booking, true);
  if (booking.status === "conflict") return { confirmed: false, failure: "SLOT_UNAVAILABLE", bookingId: booking.id };
  if (booking.status === "failed" || booking.status === "cancelled") return { confirmed: false, failure: "PROVIDER_ERROR", bookingId: booking.id };
  const claimed = await deps.store.claimPending(booking.tenantId, booking.id, PENDING_LEASE_MS / 1000);
  if (!claimed) return pending(booking.id);
  // Cleanup was attempted: never promote that event to confirmed, even if a
  // timed-out deletion is still in flight. Requires explicit owner resolution.
  if (claimed.failureCategory === "CONFLICT_CLEANUP_PENDING") return pending(booking.id);
  // pending: maybe the provider already created it before we recorded success.
  const recovered = await safeFind(deps.calendar, booking.calendarId, booking.id, booking.start, booking.end);
  if (recovered === "error") return pending(booking.id, "CALENDAR_UNAVAILABLE");
  if (recovered) return finalize(deps, claimed, recovered.eventId, booking.start, booking.end, false);
  return pending(booking.id);
}

async function markUncertain(store: BookingStore, booking: Booking, failureCategory: string, providerEventId?: string) {
  return store.update(booking.tenantId, booking.id, { failureCategory, ...(providerEventId ? { providerEventId } : {}) }, booking.leaseToken).then(() => true, () => false);
  // Even if annotation fails, the pre-existing pending row is the owner queue.
}

/** Indeterminate: neither success nor failure is established. */
function pending(bookingId: string | null, failure: CalendarFailure = "PROVIDER_ERROR"): BookingResult {
  return { confirmed: false, failure, bookingId, statusUnknown: true };
}

/** 3. post-write verification: any OTHER overlapping event -> remove ours, report conflict. */
async function finalize(deps: { store: BookingStore; calendar: CalendarProvider }, booking: Booking, eventId: string, start: string, end: string, allowCleanup = true): Promise<BookingResult> {
  if (!await markUncertain(deps.store, booking, "VERIFICATION_PENDING", eventId)) return pending(booking.id);
  let events;
  try {
    events = await deps.calendar.listEvents(booking.calendarId, start, end);
  } catch {
    return { confirmed: false, failure: "CALENDAR_UNAVAILABLE", bookingId: booking.id, statusUnknown: true };
  }
  const own = events.filter((e) => e.aiboBookingId === booking.id);
  if (own.length !== 1 || own[0].eventId !== eventId || Date.parse(own[0].start) !== Date.parse(start) || Date.parse(own[0].end) !== Date.parse(end)) {
    await markUncertain(deps.store, booking, "EVENT_MISMATCH", eventId);
    return pending(booking.id);
  }
  const competing = events.filter((e) => e.eventId !== eventId && Date.parse(e.start) < Date.parse(end) && Date.parse(e.end) > Date.parse(start));
  if (competing.length > 0) {
    if (!allowCleanup) {
      await markUncertain(deps.store, booking, "CONFLICT_REQUIRES_REVIEW", eventId);
      return pending(booking.id);
    }
    try {
      // Persist intent BEFORE deletion: a crashed/timed-out cleanup must never
      // be mistaken for an appointment awaiting positive confirmation.
      await deps.store.update(booking.tenantId, booking.id, { failureCategory: "CONFLICT_CLEANUP_PENDING", providerEventId: eventId }, booking.leaseToken);
      await deps.calendar.deleteEvent(booking.calendarId, eventId);
      await deps.store.update(booking.tenantId, booking.id, { status: "conflict", failureCategory: "SLOT_UNAVAILABLE" }, booking.leaseToken);
    } catch {
      return pending(booking.id);
    }
    return { confirmed: false, failure: "SLOT_UNAVAILABLE", bookingId: booking.id };
  }
  try {
    const saved = await deps.store.update(booking.tenantId, booking.id, { status: "confirmed", providerEventId: eventId, failureCategory: null }, booking.leaseToken);
    return ok(saved, false);
  } catch {
    return pending(booking.id);
  }
}

async function safeFind(cal: CalendarProvider, calendarId: string, bookingId: string, start: string, end: string) {
  try {
    return await cal.findByAiboBookingId(calendarId, bookingId, new Date(Date.parse(start) - 86400000).toISOString(), new Date(Date.parse(end) + 86400000).toISOString());
  } catch {
    return "error" as const;
  }
}

function ok(b: Booking, deduped: boolean): BookingResult {
  return { confirmed: true, bookingId: b.id, providerEventId: b.providerEventId!, start: b.start, end: b.end, timezone: b.timezone, deduped };
}
