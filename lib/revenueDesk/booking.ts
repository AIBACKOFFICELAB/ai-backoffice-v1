import { bookingConfigProblem, type RevenueDeskConfig } from "./config";
import { isSlotWithinPolicy } from "./slots";
import { CalendarError, type CalendarFailure, type CalendarProvider } from "./calendar/types";

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
};

export class SlotTakenError extends Error {}
export class CallAlreadyBookedError extends Error {}

export interface BookingStore {
  findByIdempotencyKey(tenantId: string, key: string): Promise<Booking | null>;
  /** Throws SlotTakenError / CallAlreadyBookedError on the DB live-booking guards. */
  insertPending(b: Omit<Booking, "id" | "providerEventId" | "status" | "failureCategory" | "updatedAt">): Promise<Booking>;
  update(tenantId: string, id: string, patch: Partial<Pick<Booking, "status" | "providerEventId" | "failureCategory">>): Promise<Booking>;
}

export type BookingResult =
  | { confirmed: true; bookingId: string; providerEventId: string; start: string; end: string; timezone: string; deduped: boolean }
  | { confirmed: false; failure: CalendarFailure; bookingId: string | null; statusUnknown?: boolean };

/** A pending row younger than this is presumed in flight on another request. */
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
  deps: { store: BookingStore; calendar: CalendarProvider; now?: () => Date },
  req: { cfg: RevenueDeskConfig; callId: string; leadId: string | null; start: string; durationMinutes: number; callerConfirmed: boolean; summary: string }
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
    if (booking.status === "confirmed") return ok(booking, true);
    if (booking.status === "conflict") return { confirmed: false, failure: "SLOT_UNAVAILABLE", bookingId: booking.id };
    if (booking.status === "failed" || booking.status === "cancelled") return { confirmed: false, failure: (booking.failureCategory as CalendarFailure) ?? "PROVIDER_ERROR", bookingId: booking.id };
    // pending: maybe the provider already created it before we recorded success.
    const recovered = await safeFind(deps.calendar, calendarId, booking.id, start, end);
    if (recovered === "error") return { confirmed: false, failure: "CALENDAR_UNAVAILABLE", bookingId: booking.id, statusUnknown: true };
    if (recovered) return finalize(deps, booking, recovered.eventId, start, end);
    if (now.getTime() - Date.parse(booking.updatedAt) < PENDING_LEASE_MS) {
      return { confirmed: false, failure: "PROVIDER_ERROR", bookingId: booking.id, statusUnknown: true };
    }
    // Lease expired and provider has no event for this id -> safe to attempt once more with the SAME id.
  } else {
    try {
      booking = await deps.store.insertPending({ tenantId: cfg.tenantId, callId: req.callId, leadId: req.leadId, idempotencyKey: key, calendarId, start, end, timezone: cfg.timezone });
    } catch (e) {
      if (e instanceof SlotTakenError) return { confirmed: false, failure: "SLOT_UNAVAILABLE", bookingId: null };
      if (e instanceof CallAlreadyBookedError) return { confirmed: false, failure: "INVALID_REQUEST", bookingId: null };
      throw e;
    }
  }

  const buf = cfg.bufferMinutes * 60000;
  // 1. pre-write free/busy check
  try {
    const busy = await deps.calendar.getBusy(calendarId, new Date(startMs - buf).toISOString(), new Date(Date.parse(end) + buf).toISOString());
    if (busy.some((b) => Date.parse(b.start) < Date.parse(end) + buf && Date.parse(b.end) > startMs - buf)) {
      await deps.store.update(cfg.tenantId, booking.id, { status: "conflict", failureCategory: "SLOT_UNAVAILABLE" });
      return { confirmed: false, failure: "SLOT_UNAVAILABLE", bookingId: booking.id };
    }
  } catch (e) {
    const cat = e instanceof CalendarError ? e.category : "PROVIDER_ERROR";
    await deps.store.update(cfg.tenantId, booking.id, { status: "failed", failureCategory: cat });
    return { confirmed: false, failure: cat, bookingId: booking.id };
  }

  // 2. write
  let eventId: string;
  try {
    const ev = await deps.calendar.createEvent(calendarId, { aiboBookingId: booking.id, tenantId: cfg.tenantId, start, end, timezone: cfg.timezone, summary: req.summary });
    eventId = ev.eventId;
  } catch {
    // Outcome unknown (timeout after provider accepted?) -> reconcile, never re-insert blindly.
    const recovered = await safeFind(deps.calendar, calendarId, booking.id, start, end);
    if (recovered && recovered !== "error") {
      eventId = recovered.eventId;
    } else if (recovered === "error") {
      return { confirmed: false, failure: "CALENDAR_UNAVAILABLE", bookingId: booking.id, statusUnknown: true }; // stays pending; next retry reconciles
    } else {
      await deps.store.update(cfg.tenantId, booking.id, { status: "failed", failureCategory: "PROVIDER_ERROR" });
      return { confirmed: false, failure: "PROVIDER_ERROR", bookingId: booking.id };
    }
  }
  return finalize(deps, booking, eventId, start, end);
}

/** 3. post-write verification: any OTHER overlapping event -> remove ours, report conflict. */
async function finalize(deps: { store: BookingStore; calendar: CalendarProvider }, booking: Booking, eventId: string, start: string, end: string): Promise<BookingResult> {
  let events;
  try {
    events = await deps.calendar.listEvents(booking.calendarId, start, end);
  } catch {
    return { confirmed: false, failure: "CALENDAR_UNAVAILABLE", bookingId: booking.id, statusUnknown: true };
  }
  const competing = events.filter((e) => e.eventId !== eventId && Date.parse(e.start) < Date.parse(end) && Date.parse(e.end) > Date.parse(start));
  if (competing.length > 0) {
    try {
      await deps.calendar.deleteEvent(booking.calendarId, eventId);
      await deps.store.update(booking.tenantId, booking.id, { status: "conflict", failureCategory: "SLOT_UNAVAILABLE" });
    } catch {
      await deps.store.update(booking.tenantId, booking.id, { status: "failed", failureCategory: "CONFLICT_CLEANUP_FAILED" });
    }
    return { confirmed: false, failure: "SLOT_UNAVAILABLE", bookingId: booking.id };
  }
  const saved = await deps.store.update(booking.tenantId, booking.id, { status: "confirmed", providerEventId: eventId, failureCategory: null });
  return ok(saved, false);
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
