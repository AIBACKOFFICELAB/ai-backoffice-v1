import { createHmac, randomUUID } from "crypto";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { parseRevenueDeskConfig, ConfigError, type RevenueDeskConfig } from "./config";
import { classifyUrgency } from "./urgency";
import { generateSlots, isSlotWithinPolicy, zonedToUtc } from "./slots";
import { bookAppointment, bookingIdempotencyKey, CallAlreadyBookedError, SlotTakenError, PENDING_LEASE_MS, type Booking, type BookingStore } from "./booking";
import { CalendarError, type CalendarProvider, type ProviderEvent } from "./calendar/types";
import { handleToolCall, startOrResumeCall, completeCall, type CallRow, type RevenueDeskStore, type RevenueDeskDeps } from "./service";
import { revenueDeskAgentDefinition, REVENUE_DESK_TOOLS } from "./tools";
import { toCanonicalIntakePayload } from "./intake";
import { summarizeCalls, computeAllowance, FOUNDER_BETA_INCLUDED_MINUTES } from "./readModel";
import { verifyVapiRequest } from "@/lib/integrations/vapi/auth";
import { parseVapiMessage } from "@/lib/integrations/vapi/parse";
import { handleVapiRequest } from "@/lib/integrations/vapi/handler";
import { getEventContract } from "@/lib/events/contracts";
import { validateIntake } from "@/lib/leads/intake/validation";
import { evaluateToolCall } from "@/lib/agents/permissions";
import type { Agent } from "@/lib/agents/types";

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: async () => { throw new Error("no db in unit tests"); } }));

const TZ = "America/New_York";
const T_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const T_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function row(over: Record<string, any> = {}) {
  return {
    tenant_id: T_A,
    enabled: true,
    timezone: TZ,
    operating_hours: { mon: { open: "08:00", close: "17:00" }, tue: { open: "08:00", close: "17:00" }, wed: { open: "08:00", close: "17:00" }, thu: { open: "08:00", close: "17:00" }, fri: { open: "08:00", close: "17:00" } },
    service_categories: ["Water Heater", "Drain Cleaning", "Leak Detection"],
    service_area: { zips: ["33101", "33102"] },
    urgency_rules: {},
    booking_enabled: true,
    default_appointment_duration_minutes: 60,
    service_durations: { "Water Heater": 120 },
    buffer_minutes: 0,
    calendar_id: "cal-a@group.calendar.google.com",
    escalation_phone: "+13055550100",
    faqs: [],
    ...over,
  };
}
const cfgA = (over: Record<string, any> = {}) => parseRevenueDeskConfig(row(over), "Acme Plumbing");

// Monday 2026-10-12 06:00 local (10:00Z, EDT) — before opening.
const MON_6AM = new Date("2026-10-12T10:00:00Z");

// ---------------------------------------------------------------- fakes
class FakeCalendar implements CalendarProvider {
  events: Array<ProviderEvent & { calendarId: string }> = [];
  busy: Array<{ start: string; end: string }> = [];
  failGetBusy = false;
  failCreateAfterWrite = false; // provider accepted but response lost
  failCreateBeforeWrite = false;
  injectCompetitorOnCreate = false;
  calls = { getBusy: 0, create: 0, find: 0, delete: 0 };
  async getBusy(calendarId: string, timeMin: string, timeMax: string) {
    this.calls.getBusy++;
    if (this.failGetBusy) throw new CalendarError("CALENDAR_UNAVAILABLE");
    const ev = this.events.filter((e) => e.calendarId === calendarId).map((e) => ({ start: e.start, end: e.end }));
    return [...this.busy, ...ev].filter((b) => Date.parse(b.start) < Date.parse(timeMax) && Date.parse(b.end) > Date.parse(timeMin));
  }
  async createEvent(calendarId: string, i: { aiboBookingId: string; start: string; end: string }) {
    this.calls.create++;
    if (this.failCreateBeforeWrite) throw new CalendarError("PROVIDER_ERROR");
    const ev = { calendarId, eventId: `ev-${this.calls.create}`, start: i.start, end: i.end, aiboBookingId: i.aiboBookingId };
    this.events.push(ev);
    if (this.injectCompetitorOnCreate) this.events.push({ calendarId, eventId: "competitor", start: i.start, end: i.end, aiboBookingId: null });
    if (this.failCreateAfterWrite) throw new CalendarError("CALENDAR_UNAVAILABLE");
    return ev;
  }
  async findByAiboBookingId(calendarId: string, id: string) {
    this.calls.find++;
    return this.events.find((e) => e.calendarId === calendarId && e.aiboBookingId === id) ?? null;
  }
  async listEvents(calendarId: string, timeMin: string, timeMax: string) {
    return this.events.filter((e) => e.calendarId === calendarId && Date.parse(e.start) < Date.parse(timeMax) && Date.parse(e.end) > Date.parse(timeMin));
  }
  async deleteEvent(calendarId: string, eventId: string) {
    this.calls.delete++;
    this.events = this.events.filter((e) => !(e.calendarId === calendarId && e.eventId === eventId));
  }
}

class FakeBookingStore implements BookingStore {
  rows: Booking[] = [];
  async findByIdempotencyKey(tenantId: string, key: string) {
    return this.rows.find((r) => r.tenantId === tenantId && r.idempotencyKey === key) ?? null;
  }
  async insertPending(b: Omit<Booking, "id" | "providerEventId" | "status" | "failureCategory" | "updatedAt">) {
    const live = this.rows.filter((r) => r.tenantId === b.tenantId && (r.status === "pending" || r.status === "confirmed"));
    if (live.some((r) => r.callId === b.callId)) throw new CallAlreadyBookedError();
    if (live.some((r) => r.calendarId === b.calendarId && r.start === b.start)) throw new SlotTakenError();
    const r: Booking = { ...b, id: randomUUID(), providerEventId: null, status: "pending", failureCategory: null, updatedAt: new Date().toISOString() };
    this.rows.push(r);
    return r;
  }
  async update(tenantId: string, id: string, patch: Partial<Booking>) {
    const r = this.rows.find((x) => x.tenantId === tenantId && x.id === id)!;
    Object.assign(r, patch, { updatedAt: new Date().toISOString() });
    return r;
  }
}

function agentFor(tenantId: string, status: Agent["status"] = "active"): Agent {
  const def = revenueDeskAgentDefinition(tenantId);
  return { ...def, id: `agent-${tenantId}`, status, purpose: def.purpose ?? null, allowedTools: def.allowedTools!, readScopes: def.readScopes!, writeScopes: def.writeScopes!, approvalPolicy: def.approvalPolicy!, modelPolicy: {}, systemInstructions: null, instructionsVersion: 1, createdAt: "", updatedAt: "" };
}

class FakeStore implements RevenueDeskStore {
  configs = new Map<string, RevenueDeskConfig>(); // providerPhoneNumberId -> config
  agents = new Map<string, Agent>();
  calls: Array<CallRow & Record<string, any>> = [];
  leads: Array<{ tenantId: string; id: string; sourceRef: string; payload: Record<string, unknown> }> = [];
  events: Array<{ tenantId: string; eventType: string; idempotencyKey: string; payload: Record<string, unknown> }> = [];
  failLead = false;
  async resolveTenantByProviderNumber(id: string) {
    const c = this.configs.get(id);
    return c ? { config: c } : null;
  }
  async upsertCall(i: { tenantId: string; providerCallId: string; callerPhone: string | null }) {
    const existing = this.calls.find((c) => c.tenantId === i.tenantId && c.providerCallId === i.providerCallId);
    if (existing) return { call: { ...existing }, created: false };
    const c = { id: randomUUID(), tenantId: i.tenantId, providerCallId: i.providerCallId, callerPhone: i.callerPhone, leadId: null, status: "in_progress" as const, priority: null, intake: null, escalationReason: null };
    this.calls.push(c);
    return { call: { ...c }, created: true };
  }
  async updateCall(tenantId: string, callId: string, patch: Record<string, unknown>) {
    const c = this.calls.find((x) => x.tenantId === tenantId && x.id === callId);
    if (!c) throw new Error("cross-tenant update refused");
    Object.assign(c, patch);
  }
  async getAgent(tenantId: string) {
    return this.agents.get(tenantId) ?? null;
  }
  async createLead(tenantId: string, payload: Record<string, unknown>) {
    if (this.failLead) throw new Error("db down");
    validateIntake(payload); // the REAL canonical intake contract
    const existing = this.leads.find((l) => l.tenantId === tenantId && l.sourceRef === payload.sourceRef);
    if (existing) return existing.id;
    const l = { tenantId, id: randomUUID(), sourceRef: String(payload.sourceRef), payload };
    this.leads.push(l);
    return l.id;
  }
  async emit(i: any) {
    const contract = getEventContract(i.eventType);
    const v = contract!.validatePayload(i.payload);
    if (!v.ok) throw new Error(v.errors.join(";"));
    if (this.events.some((e) => e.tenantId === i.tenantId && e.idempotencyKey === i.idempotencyKey)) return;
    this.events.push(i);
  }
}

function world(now = MON_6AM) {
  const store = new FakeStore();
  const a = cfgA();
  const b = parseRevenueDeskConfig(row({ tenant_id: T_B, calendar_id: "cal-b@group.calendar.google.com", escalation_phone: "+13055550199" }), "Bravo HVAC");
  store.configs.set("pn-A", a);
  store.configs.set("pn-B", b);
  store.agents.set(T_A, agentFor(T_A));
  store.agents.set(T_B, agentFor(T_B));
  const calendar = new FakeCalendar();
  const bookings = new FakeBookingStore();
  const deps: RevenueDeskDeps = { store, calendar, bookings, now: () => now };
  return { store, calendar, bookings, deps };
}

const intakeArgs = (over: Record<string, unknown> = {}) => ({
  customerName: "Synthetic Caller",
  callbackPhone: "+13055551234",
  serviceAddress: "1 Test St",
  postalCode: "33101",
  serviceCategory: "Water Heater",
  jobDescription: "Water heater not producing hot water",
  urgencySignals: [],
  preferredTiming: "Monday morning",
  ...over,
});

async function startCall(deps: RevenueDeskDeps, pn = "pn-A", providerCallId = "vapi-call-1") {
  const ctx = await startOrResumeCall(deps, { providerCallId, providerPhoneNumberId: pn, callerPhone: "+13055551234", calledPhone: "+13055550000", startedAt: MON_6AM.toISOString() });
  if (!ctx) throw new Error("no ctx");
  return ctx;
}

// ================================================================= tests

describe("config", () => {
  it("parses a valid config and always forces safety signals to escalate", () => {
    const c = cfgA({ urgency_rules: { escalate: ["complaint"], urgent: [] } });
    expect(c.urgencyRules.escalate).toEqual(expect.arrayContaining(["complaint", "suspected_gas", "electrical_hazard", "caller_requests_human"]));
  });
  it("rejects invalid timezone, hours, and non-E.164 escalation phone", () => {
    expect(() => cfgA({ timezone: "Mars/Base" })).toThrow(ConfigError);
    expect(() => cfgA({ operating_hours: { mon: { open: "18:00", close: "09:00" } } })).toThrow(ConfigError);
    expect(() => cfgA({ escalation_phone: "305-555-0100" })).toThrow(ConfigError);
  });
});

describe("urgency classifier (deterministic policy, model cannot override)", () => {
  const c = cfgA();
  it("routine supported in-area request -> offer booking", () => {
    expect(classifyUrgency(c, { signals: [], serviceCategory: "Water Heater", postalCode: "33101" })).toMatchObject({ priority: "routine", requiredAction: "offer_booking" });
  });
  it.each(["suspected_gas", "electrical_hazard", "caller_requests_human", "pricing_negotiation", "complaint", "sewage_backup", "caller_says_emergency"])("%s -> human escalation", (s) => {
    expect(classifyUrgency(c, { signals: [s], serviceCategory: "Water Heater", postalCode: "33101" })).toMatchObject({ priority: "human_escalation_required", requiredAction: "escalate" });
  });
  it("unknown signal, unsupported service, missing/out-of-area zip all fail toward a human", () => {
    expect(classifyUrgency(c, { signals: ["model_made_this_up"], serviceCategory: "Water Heater", postalCode: "33101" }).requiredAction).toBe("escalate");
    expect(classifyUrgency(c, { signals: [], serviceCategory: "Roofing", postalCode: "33101" }).reasons).toContain("service_not_supported");
    expect(classifyUrgency(c, { signals: [], serviceCategory: "Water Heater", postalCode: "90210" }).reasons).toContain("outside_service_area");
    expect(classifyUrgency(c, { signals: [], serviceCategory: "Water Heater", postalCode: null }).requiredAction).toBe("escalate");
  });
  it("urgent signal escalates unless the tenant explicitly allows urgent booking", () => {
    expect(classifyUrgency(c, { signals: ["no_water"], serviceCategory: "Water Heater", postalCode: "33101" })).toMatchObject({ priority: "urgent", requiredAction: "escalate" });
    const allow = cfgA({ urgency_rules: { escalate: [], urgent: ["no_water"], allowUrgentBooking: true } });
    expect(classifyUrgency(allow, { signals: ["no_water"], serviceCategory: "Water Heater", postalCode: "33101" })).toMatchObject({ priority: "urgent", requiredAction: "offer_booking" });
  });
});

describe("slots (timezone, hours, busy, DST)", () => {
  const c = cfgA();
  it("generates in-hours, non-overlapping slots in the tenant timezone", () => {
    const slots = generateSlots(c, { now: MON_6AM, durationMinutes: 60, busy: [], leadTimeMinutes: 0 });
    expect(slots[0].start).toBe("2026-10-12T12:00:00.000Z"); // 08:00 EDT
    expect(slots).toHaveLength(3);
    expect(Date.parse(slots[1].start)).toBeGreaterThanOrEqual(Date.parse(slots[0].end));
  });
  it("excludes busy blocks and weekends; never invents availability", () => {
    const busy = [{ start: "2026-10-12T12:00:00Z", end: "2026-10-12T21:00:00Z" }]; // whole Monday
    const slots = generateSlots(c, { now: MON_6AM, durationMinutes: 60, busy, leadTimeMinutes: 0 });
    expect(slots[0].start.startsWith("2026-10-13")).toBe(true);
    const sat = new Date("2026-10-17T10:00:00Z");
    expect(generateSlots(c, { now: sat, durationMinutes: 60, busy: [], days: 2, leadTimeMinutes: 0 })).toEqual([]);
  });
  it("is DST-correct (EST after Nov 1 2026)", () => {
    expect(zonedToUtc(2026, 11, 2, 8, 0, TZ).toISOString()).toBe("2026-11-02T13:00:00.000Z");
    expect(zonedToUtc(2026, 10, 12, 8, 0, TZ).toISOString()).toBe("2026-10-12T12:00:00.000Z");
  });
  it("policy re-validation rejects out-of-hours or past slots chosen by the model", () => {
    expect(isSlotWithinPolicy(c, "2026-10-12T12:00:00Z", 60, MON_6AM)).toBe(true);
    expect(isSlotWithinPolicy(c, "2026-10-12T22:00:00Z", 60, MON_6AM)).toBe(false);
    expect(isSlotWithinPolicy(c, "2026-10-12T20:30:00Z", 60, MON_6AM)).toBe(false); // runs past close
    expect(isSlotWithinPolicy(c, "2026-10-11T12:00:00Z", 60, MON_6AM)).toBe(false);
  });
});

describe("booking state machine", () => {
  const base = (calendar = new FakeCalendar(), store = new FakeBookingStore()) => ({ calendar, store, deps: { calendar, store, now: () => MON_6AM } });
  const req = (over: Record<string, any> = {}) => ({ cfg: cfgA(), callId: "call-1", leadId: "lead-1", start: "2026-10-12T14:00:00Z", durationMinutes: 60, callerConfirmed: true, summary: "x", ...over });

  it("open slot -> exactly one confirmed booking with provider event id", async () => {
    const { calendar, store, deps } = base();
    const r = await bookAppointment(deps, req());
    expect(r).toMatchObject({ confirmed: true, providerEventId: "ev-1" });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0].status).toBe("confirmed");
    expect(calendar.events).toHaveLength(1);
  });
  it("refuses unconfirmed slots and invalid config without touching the calendar", async () => {
    const { calendar, deps } = base();
    expect(await bookAppointment(deps, req({ callerConfirmed: false }))).toMatchObject({ confirmed: false, failure: "INVALID_REQUEST" });
    expect(await bookAppointment(deps, req({ cfg: cfgA({ booking_enabled: false }) }))).toMatchObject({ failure: "CONFIGURATION_ERROR" });
    expect(calendar.calls.create).toBe(0);
  });
  it("pre-write conflict (busy) -> conflict, no event created", async () => {
    const { calendar, store, deps } = base();
    calendar.busy.push({ start: "2026-10-12T14:30:00Z", end: "2026-10-12T15:30:00Z" });
    expect(await bookAppointment(deps, req())).toMatchObject({ confirmed: false, failure: "SLOT_UNAVAILABLE" });
    expect(calendar.calls.create).toBe(0);
    expect(store.rows[0].status).toBe("conflict");
  });
  it("post-write conflict (competing event appears) -> our event removed, conflict reported", async () => {
    const { calendar, store, deps } = base();
    calendar.injectCompetitorOnCreate = true;
    expect(await bookAppointment(deps, req())).toMatchObject({ confirmed: false, failure: "SLOT_UNAVAILABLE" });
    expect(calendar.events.map((e) => e.eventId)).toEqual(["competitor"]);
    expect(store.rows[0].status).toBe("conflict");
  });
  it("provider outage -> failed, never reported booked", async () => {
    const { calendar, store, deps } = base();
    calendar.failGetBusy = true;
    expect(await bookAppointment(deps, req())).toMatchObject({ confirmed: false, failure: "CALENDAR_UNAVAILABLE" });
    expect(store.rows[0].status).toBe("failed");
  });
  it("provider success + lost response is RECOVERED by AIBO booking id, not re-inserted", async () => {
    const { calendar, store, deps } = base();
    calendar.failCreateAfterWrite = true;
    const r = await bookAppointment(deps, req());
    expect(r).toMatchObject({ confirmed: true, providerEventId: "ev-1" });
    expect(calendar.events).toHaveLength(1);
    expect(store.rows[0].status).toBe("confirmed");
  });
  it("duplicate retry of a confirmed booking dedupes (no second event)", async () => {
    const { calendar, deps } = base();
    await bookAppointment(deps, req());
    const again = await bookAppointment(deps, req());
    expect(again).toMatchObject({ confirmed: true, deduped: true });
    expect(calendar.calls.create).toBe(1);
  });
  it("in-flight pending booking within lease -> status unknown, no blind second insert; reconciles once provider shows it", async () => {
    const { calendar, store } = base();
    const cfg = cfgA();
    const key = bookingIdempotencyKey("call-1", "2026-10-12T14:00:00.000Z", 60);
    const pending = await store.insertPending({ tenantId: cfg.tenantId, callId: "call-1", leadId: "lead-1", idempotencyKey: key, calendarId: cfg.calendarId!, start: "2026-10-12T14:00:00.000Z", end: "2026-10-12T15:00:00.000Z", timezone: TZ });
    const inLease = { calendar, store, now: () => new Date(Date.parse(pending.updatedAt) + 1000) };
    expect(await bookAppointment(inLease, req())).toMatchObject({ confirmed: false, statusUnknown: true });
    expect(calendar.calls.create).toBe(0);
    calendar.events.push({ calendarId: cfg.calendarId!, eventId: "ev-recovered", start: pending.start, end: pending.end, aiboBookingId: pending.id });
    expect(await bookAppointment(inLease, req())).toMatchObject({ confirmed: true, providerEventId: "ev-recovered" });
    expect(calendar.calls.create).toBe(0);
  });
  it("expired pending lease with no provider event -> one retry with the SAME booking id", async () => {
    const { calendar, store } = base();
    const cfg = cfgA();
    const key = bookingIdempotencyKey("call-1", "2026-10-12T14:00:00.000Z", 60);
    const pending = await store.insertPending({ tenantId: cfg.tenantId, callId: "call-1", leadId: "lead-1", idempotencyKey: key, calendarId: cfg.calendarId!, start: "2026-10-12T14:00:00.000Z", end: "2026-10-12T15:00:00.000Z", timezone: TZ });
    const later = { calendar, store, now: () => new Date(Date.parse(pending.updatedAt) + PENDING_LEASE_MS + 1000) };
    expect(await bookAppointment(later, req())).toMatchObject({ confirmed: true, bookingId: pending.id });
    expect(calendar.events[0].aiboBookingId).toBe(pending.id);
  });
  it("AIBO slot guard: a second call cannot book a slot already live for this calendar", async () => {
    const { calendar, deps } = base();
    await bookAppointment(deps, req());
    expect(await bookAppointment(deps, req({ callId: "call-2" }))).toMatchObject({ confirmed: false, failure: "SLOT_UNAVAILABLE" });
    expect(calendar.calls.create).toBe(1);
  });
});

describe("Scenario A — routine booking end to end (fakes)", () => {
  it("correct tenant, one call, one canonical lead, deterministic urgency, slots, one confirmed booking, evidence, no sends", async () => {
    const { store, calendar, bookings, deps } = world();
    const ctx = await startCall(deps);
    expect(ctx.config.tenantId).toBe(T_A);
    const cap = await handleToolCall(deps, ctx, "revenue_desk_capture_intake", intakeArgs());
    expect(cap).toMatchObject({ ok: true, priority: "routine", requiredAction: "offer_booking" });
    expect(await handleToolCall(deps, ctx, "revenue_desk_classify_urgency", {})).toMatchObject({ priority: "routine" });
    const avail = (await handleToolCall(deps, ctx, "revenue_desk_check_availability", {})) as any;
    expect(avail.slots.length).toBeGreaterThan(0);
    const slot = avail.slots[0];
    expect(slot.durationMinutes).toBe(120); // service-specific duration
    const booked = await handleToolCall(deps, ctx, "revenue_desk_book_appointment", { slotStart: slot.slotStart, durationMinutes: slot.durationMinutes, callerConfirmed: true });
    expect(booked).toMatchObject({ ok: true, booked: true });
    await completeCall(deps, ctx, { endedAt: null, startedAt: null, durationSeconds: 125, costUsd: 0.25, endedReason: "customer-ended-call", transferred: null });

    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({ status: "booked", bookingOutcome: "confirmed", priority: "routine", durationSeconds: 125, providerCostUsd: 0.25 });
    expect(store.leads).toHaveLength(1);
    expect(store.leads[0].payload).toMatchObject({ sourceRef: ctx.call.id, serviceType: "Water Heater", emergency: "No" });
    expect(bookings.rows.filter((r) => r.status === "confirmed")).toHaveLength(1);
    expect(calendar.events).toHaveLength(1);
    expect(store.events.filter((e) => e.eventType !== "revenue_desk.tool_attempted").map((e) => e.eventType)).toEqual([
      "revenue_desk.call_started", "revenue_desk.intake_captured", "revenue_desk.urgency_classified", "revenue_desk.availability_checked",
      "revenue_desk.booking_requested", "revenue_desk.booking_confirmed", "revenue_desk.call_completed",
    ]);
  });
  it("model cannot book an unconfirmed slot or a slot with a forged duration", async () => {
    const { deps, calendar } = world();
    const ctx = await startCall(deps);
    await handleToolCall(deps, ctx, "revenue_desk_capture_intake", intakeArgs());
    expect(await handleToolCall(deps, ctx, "revenue_desk_book_appointment", { slotStart: "2026-10-12T12:00:00Z", durationMinutes: 120, callerConfirmed: false })).toMatchObject({ ok: false, error: "INVALID_REQUEST" });
    expect(await handleToolCall(deps, ctx, "revenue_desk_book_appointment", { slotStart: "2026-10-12T12:00:00Z", durationMinutes: 15, callerConfirmed: true })).toMatchObject({ ok: false, error: "INVALID_REQUEST" });
    expect(calendar.calls.create).toBe(0);
  });
});

describe("Scenario B — urgent / human escalation", () => {
  it("intake preserved, deterministic escalation, booking refused, route from config only", async () => {
    const { store, calendar, deps } = world();
    const ctx = await startCall(deps);
    const cap = await handleToolCall(deps, ctx, "revenue_desk_capture_intake", intakeArgs({ urgencySignals: ["suspected_gas"] }));
    expect(cap).toMatchObject({ ok: true, priority: "human_escalation_required", requiredAction: "escalate" });
    expect(store.leads).toHaveLength(1);
    expect(store.leads[0].payload).toMatchObject({ emergency: "Yes", urgency: "Emergency" });
    expect(await handleToolCall(deps, ctx, "revenue_desk_check_availability", {})).toMatchObject({ ok: false, requiredAction: "escalate" });
    expect(await handleToolCall(deps, ctx, "revenue_desk_book_appointment", { slotStart: "2026-10-12T12:00:00Z", durationMinutes: 120, callerConfirmed: true })).toMatchObject({ ok: false, requiredAction: "escalate" });
    const route = (await handleToolCall(deps, ctx, "revenue_desk_get_escalation_route", { reason: "suspected_gas" })) as any;
    expect(route).toMatchObject({ ok: true, transferAvailable: true });
    expect(JSON.stringify(route)).not.toContain("+1305"); // number never exposed to the model
    expect(calendar.calls.getBusy + calendar.calls.create).toBe(0);
    await completeCall(deps, ctx, { endedAt: null, startedAt: null, durationSeconds: 60, costUsd: null, endedReason: "assistant-forwarded-call", transferred: true });
    expect(store.calls[0]).toMatchObject({ status: "escalated", escalationReason: "suspected_gas", escalationResult: "transferred" });
  });
  it("model cannot supply an arbitrary transfer destination", async () => {
    const { deps } = world();
    const ctx = await startCall(deps);
    expect(await handleToolCall(deps, ctx, "revenue_desk_get_escalation_route", { reason: "x", number: "+19995550000" })).toMatchObject({ ok: false, error: "INVALID_REQUEST" });
  });
  it("transfer failure is recorded truthfully", async () => {
    const { store, deps } = world();
    const ctx = await startCall(deps);
    await handleToolCall(deps, ctx, "revenue_desk_get_escalation_route", { reason: "caller_requests_human" });
    ctx.call.status = "escalated";
    await completeCall(deps, ctx, { endedAt: null, startedAt: null, durationSeconds: 30, costUsd: null, endedReason: "assistant-forwarded-call-failed", transferred: false });
    expect(store.calls[0].escalationResult).toBe("transfer_failed");
  });
});

describe("Scenario C — calendar failure", () => {
  it("intake preserved, zero booking claim, escalation instruction, failure visible", async () => {
    const { store, calendar, bookings, deps } = world();
    calendar.failGetBusy = true;
    const ctx = await startCall(deps);
    await handleToolCall(deps, ctx, "revenue_desk_capture_intake", intakeArgs());
    const r = await handleToolCall(deps, ctx, "revenue_desk_check_availability", {});
    expect(r).toMatchObject({ ok: false, error: "CALENDAR_UNAVAILABLE", requiredAction: "escalate" });
    expect(r.slots).toBeUndefined();
    expect(store.leads).toHaveLength(1);
    expect(bookings.rows).toHaveLength(0);
    expect(store.calls[0]).toMatchObject({ failureCategory: "CALENDAR_UNAVAILABLE", bookingOutcome: "unavailable" });
  });
  it("database failure on intake is never reported as saved", async () => {
    const { store, deps } = world();
    store.failLead = true;
    const ctx = await startCall(deps);
    expect(await handleToolCall(deps, ctx, "revenue_desk_capture_intake", intakeArgs())).toMatchObject({ ok: false, error: "INTAKE_NOT_SAVED" });
  });
});

describe("Scenario D — duplicate delivery", () => {
  it("replayed call-start, intake, and booking create no duplicates", async () => {
    const { store, calendar, bookings, deps } = world();
    const ctx1 = await startCall(deps);
    const ctx2 = await startCall(deps); // provider redelivery
    expect(ctx2.call.id).toBe(ctx1.call.id);
    await handleToolCall(deps, ctx1, "revenue_desk_capture_intake", intakeArgs());
    await handleToolCall(deps, ctx2, "revenue_desk_capture_intake", intakeArgs());
    const avail = (await handleToolCall(deps, ctx1, "revenue_desk_check_availability", {})) as any;
    const args = { slotStart: avail.slots[0].slotStart, durationMinutes: avail.slots[0].durationMinutes, callerConfirmed: true };
    await handleToolCall(deps, ctx1, "revenue_desk_book_appointment", args);
    ctx2.call = { ...ctx1.call };
    const replay = await handleToolCall(deps, ctx2, "revenue_desk_book_appointment", args);
    expect(replay).toMatchObject({ ok: true, booked: true });
    expect(store.calls).toHaveLength(1);
    expect(store.leads).toHaveLength(1);
    expect(bookings.rows).toHaveLength(1);
    expect(calendar.events).toHaveLength(1);
    expect(store.events.filter((e) => e.eventType === "revenue_desk.call_started")).toHaveLength(1);
    expect(store.events.filter((e) => e.eventType === "revenue_desk.booking_confirmed")).toHaveLength(1);
  });
});

describe("Scenario E — tenant isolation / forging", () => {
  it("tenant comes only from the trusted provider number; model args cannot carry tenantId", async () => {
    const { store, deps } = world();
    const ctx = await startCall(deps, "pn-A");
    expect(await handleToolCall(deps, ctx, "revenue_desk_capture_intake", { ...intakeArgs(), tenantId: T_B })).toMatchObject({ ok: false, error: "INVALID_REQUEST" });
    expect(store.leads).toHaveLength(0);
  });
  it("tenant A's call context never touches tenant B's calendar or config", async () => {
    const { calendar, deps } = world();
    const ctx = await startCall(deps, "pn-A");
    await handleToolCall(deps, ctx, "revenue_desk_capture_intake", intakeArgs());
    const spy = vi.spyOn(calendar, "getBusy");
    await handleToolCall(deps, ctx, "revenue_desk_check_availability", {});
    expect(spy.mock.calls.every((c) => c[0] === "cal-a@group.calendar.google.com")).toBe(true);
  });
  it("same provider call id under another tenant's number is a separate, isolated call", async () => {
    const { store, deps } = world();
    const a = await startCall(deps, "pn-A", "dup");
    const b = await startCall(deps, "pn-B", "dup");
    expect(a.call.id).not.toBe(b.call.id);
    expect(store.calls.map((c) => c.tenantId).sort()).toEqual([T_A, T_B].sort());
  });
  it("unknown or disabled number resolves no tenant", async () => {
    const { store, deps } = world();
    expect(await startOrResumeCall(deps, { providerCallId: "x", providerPhoneNumberId: "pn-unknown", callerPhone: null, calledPhone: null, startedAt: null })).toBeNull();
    store.configs.set("pn-off", cfgA({ enabled: false }));
    expect(await startOrResumeCall(deps, { providerCallId: "y", providerPhoneNumberId: "pn-off", callerPhone: null, calledPhone: null, startedAt: null })).toBeNull();
    expect(await startOrResumeCall(deps, { providerCallId: "z", providerPhoneNumberId: null, callerPhone: null, calledPhone: null, startedAt: null })).toBeNull();
  });
  it("inactive or missing agent -> policy denial before any tool executes", async () => {
    const { store, deps, calendar } = world();
    store.agents.set(T_A, agentFor(T_A, "inactive"));
    const ctx = await startCall(deps);
    expect(await handleToolCall(deps, ctx, "revenue_desk_capture_intake", intakeArgs())).toMatchObject({ ok: false, reason: "policy_denied" });
    store.agents.delete(T_A);
    expect(await handleToolCall(deps, ctx, "revenue_desk_check_availability", {})).toMatchObject({ reason: "agent_not_registered" });
    expect(store.leads).toHaveLength(0);
    expect(calendar.calls.getBusy).toBe(0);
  });
});

describe("tool-execution audit (every attempt reconstructable)", () => {
  const attempts = (store: FakeStore) => store.events.filter((e) => e.eventType === "revenue_desk.tool_attempted").map((e) => e.payload);
  it("records success for all five tools with tool, agent, call, lead, booking ids", async () => {
    const { store, deps } = world();
    const ctx = await startCall(deps);
    await handleToolCall(deps, ctx, "revenue_desk_capture_intake", intakeArgs(), "tc1");
    await handleToolCall(deps, ctx, "revenue_desk_classify_urgency", {}, "tc2");
    const avail = (await handleToolCall(deps, ctx, "revenue_desk_check_availability", {}, "tc3")) as any;
    await handleToolCall(deps, ctx, "revenue_desk_book_appointment", { slotStart: avail.slots[0].slotStart, durationMinutes: 120, callerConfirmed: true }, "tc4");
    await handleToolCall(deps, ctx, "revenue_desk_get_escalation_route", { reason: "caller_requests_human" }, "tc5");
    const a = attempts(store);
    expect(a.map((x) => x.toolName)).toEqual(Object.keys(REVENUE_DESK_TOOLS));
    expect(a.every((x) => x.outcome === "succeeded" && x.callId === ctx.call.id && x.agentId === `agent-${T_A}`)).toBe(true);
    expect(a[3].bookingId).toEqual(expect.any(String));
    expect(a[3].leadId).toEqual(store.leads[0].id);
  });
  it("records refusals, invalid input, unknown tools and failures — with sanitized codes and no arguments", async () => {
    const { store, calendar, deps } = world();
    const ctx = await startCall(deps);
    await handleToolCall(deps, ctx, "revenue_desk_capture_intake", { ...intakeArgs(), tenantId: T_B }, "bad");
    await handleToolCall(deps, ctx, "send_sms", {}, "unk");
    await handleToolCall(deps, ctx, "revenue_desk_capture_intake", intakeArgs(), "ok");
    calendar.failGetBusy = true;
    await handleToolCall(deps, ctx, "revenue_desk_check_availability", {}, "fail");
    store.agents.set(T_A, agentFor(T_A, "inactive"));
    await handleToolCall(deps, ctx, "revenue_desk_classify_urgency", {}, "deny");
    expect(attempts(store).map((x) => [x.toolName, x.outcome, x.failureCategory])).toEqual([
      ["revenue_desk_capture_intake", "invalid_input", "INVALID_REQUEST"],
      ["unknown_tool", "refused", "unknown_tool"],
      ["revenue_desk_capture_intake", "succeeded", null],
      ["revenue_desk_check_availability", "failed", "CALENDAR_UNAVAILABLE"],
      ["revenue_desk_classify_urgency", "refused", "policy_denied"],
    ]);
    expect(JSON.stringify(attempts(store))).not.toMatch(/Synthetic Caller|1 Test St|\+1305|Water heater not/);
  });
  it("a redelivered provider tool call is audited once", async () => {
    const { store, deps } = world();
    const ctx = await startCall(deps);
    await handleToolCall(deps, ctx, "revenue_desk_classify_urgency", {}, "same");
    await handleToolCall(deps, ctx, "revenue_desk_classify_urgency", {}, "same");
    expect(attempts(store)).toHaveLength(1);
  });
});

describe("agent governance", () => {
  it("every Revenue Desk tool is allowed for the active receptionist agent and none needs approval", () => {
    const agent = agentFor(T_A);
    for (const tool of Object.values(REVENUE_DESK_TOOLS)) expect(evaluateToolCall(agent, tool)).toMatchObject({ decision: "allow" });
  });
  it("no Revenue Desk tool carries SEND/FINANCIAL/DELETE permission or customer-facing side effects", () => {
    for (const tool of Object.values(REVENUE_DESK_TOOLS)) {
      expect(["SEND", "FINANCIAL_ACTION", "DELETE", "APPROVE"]).not.toContain(tool.intrinsicPermission);
      expect(tool.sideEffectClass).not.toBe("customer_facing");
    }
  });
  it("registers as csr_lead_recovery, INACTIVE by default", () => {
    expect(revenueDeskAgentDefinition(T_A)).toMatchObject({ agentType: "csr_lead_recovery", status: "inactive", name: "Revenue Desk Receptionist" });
  });
});

describe("canonical intake mapping", () => {
  it("produces a payload the real canonical validator accepts, with server-side defaults", () => {
    const d = classifyUrgency(cfgA(), { signals: [], serviceCategory: "Water Heater", postalCode: "33101" });
    const id = randomUUID();
    const p = toCanonicalIntakePayload(id, "+13055551234", { ...intakeArgs(), callbackPhone: null, serviceAddress: null, notes: null } as any, d);
    expect(() => validateIntake(p)).not.toThrow();
    expect(p).toMatchObject({ sourceRef: id, phone: "+13055551234", serviceAddress: "Not provided on call", propertyType: "Other", email: "" });
  });
});

describe("event privacy contracts", () => {
  const c = getEventContract("revenue_desk.intake_captured")!;
  it("allows ids/codes/numbers only", () => {
    expect(c.validatePayload({ callId: randomUUID(), leadId: randomUUID(), serviceCategory: "Water Heater" }).ok).toBe(true);
  });
  it.each([["callerPhone", "+13055551234"], ["serviceAddress", "1 Test St"], ["transcript", "hello"], ["recordingUrl", "https://x"], ["customerName", "A"], ["error", "stack"]])("rejects %s", (k, v) => {
    expect(c.validatePayload({ callId: "x", [k]: v }).ok).toBe(false);
  });
  it("every revenue_desk event type is registered and requires idempotency", () => {
    for (const t of ["tool_attempted", "call_started", "intake_captured", "urgency_classified", "availability_checked", "booking_requested", "booking_confirmed", "booking_failed", "escalation_requested", "call_completed", "call_failed"]) {
      expect(getEventContract(`revenue_desk.${t}`)?.idempotency).toBe("required");
    }
  });
});

describe("Vapi webhook authentication", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ message: { type: "status-update", call: { id: "c1" } } });
  const now = 1_800_000_000;
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
  const sign = (ts: string, b = body, s = secret) => createHmac("sha256", s).update(`${ts}.${b}`).digest("hex");

  it("accepts a valid hex or base64 signature", () => {
    expect(verifyVapiRequest(body, headers({ "x-vapi-timestamp": String(now), "x-vapi-signature": sign(String(now)) }), secret, now)).toEqual({ ok: true });
    const b64 = createHmac("sha256", secret).update(`${now}.${body}`).digest("base64");
    expect(verifyVapiRequest(body, headers({ "x-vapi-timestamp": String(now), "x-vapi-signature": b64 }), secret, now)).toEqual({ ok: true });
  });
  it("rejects missing secret, missing/bad signature, tampered body, and replays", () => {
    const ts = String(now);
    expect(verifyVapiRequest(body, headers({ "x-vapi-timestamp": ts, "x-vapi-signature": sign(ts) }), undefined, now)).toMatchObject({ ok: false, reason: "no-secret" });
    expect(verifyVapiRequest(body, headers({ "x-vapi-timestamp": ts }), secret, now)).toMatchObject({ reason: "missing-signature" });
    expect(verifyVapiRequest(body, headers({ "x-vapi-signature": sign(ts) }), secret, now)).toMatchObject({ reason: "missing-timestamp" });
    expect(verifyVapiRequest(body + " ", headers({ "x-vapi-timestamp": ts, "x-vapi-signature": sign(ts) }), secret, now)).toMatchObject({ reason: "bad-signature" });
    expect(verifyVapiRequest(body, headers({ "x-vapi-timestamp": ts, "x-vapi-signature": sign(ts, body, "wrong") }), secret, now)).toMatchObject({ reason: "bad-signature" });
    const old = String(now - 301);
    expect(verifyVapiRequest(body, headers({ "x-vapi-timestamp": old, "x-vapi-signature": sign(old) }), secret, now)).toMatchObject({ reason: "stale" });
  });
});

describe("Vapi adapter", () => {
  const secret = "s";
  function signed(payload: unknown, ct = "application/json") {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const h: Record<string, string> = { "x-vapi-timestamp": ts, "x-vapi-signature": sig };
    return { body, contentType: ct, headers: { get: (n: string) => h[n.toLowerCase()] ?? null } };
  }
  const call = { id: "vapi-call-9", phoneNumberId: "pn-A", customer: { number: "+13055551234" } };

  it("parses tool calls including string arguments", () => {
    const m = parseVapiMessage({ message: { type: "tool-calls", call, toolCallList: [{ id: "t1", function: { name: "revenue_desk_classify_urgency", arguments: "{}" } }] } });
    expect(m).toMatchObject({ kind: "tool-calls", toolCalls: [{ id: "t1", name: "revenue_desk_classify_urgency", args: {} }] });
  });
  it("rejects unauthenticated, wrong content type, and oversized bodies before any domain call", async () => {
    const { deps, store } = world();
    const unsigned = { body: JSON.stringify({ message: { type: "assistant-request", call } }), contentType: "application/json", headers: { get: () => null } };
    expect((await handleVapiRequest(unsigned, deps, secret)).status).toBe(401);
    expect((await handleVapiRequest(signed({ message: { type: "assistant-request", call } }, "text/plain"), deps, secret)).status).toBe(415);
    expect((await handleVapiRequest({ ...signed({}), body: "x".repeat(300_000) }, deps, secret)).status).toBe(413);
    expect(store.calls).toHaveLength(0);
  });
  it("assistant-request greets as the resolved tenant; unknown number reveals no business", async () => {
    const { deps } = world();
    const ok = await handleVapiRequest(signed({ message: { type: "assistant-request", call } }), deps, secret);
    expect(JSON.stringify(ok.body)).toContain("Acme Plumbing");
    expect(JSON.stringify(ok.body)).not.toContain("Bravo");
    const unknown = await handleVapiRequest(signed({ message: { type: "assistant-request", call: { ...call, phoneNumberId: "pn-zzz" } } }), deps, secret);
    expect(JSON.stringify(unknown.body)).not.toMatch(/Acme|Bravo/);
  });
  it("transfer-destination comes from tenant config, never from the payload", async () => {
    const { deps } = world();
    const r = await handleVapiRequest(signed({ message: { type: "transfer-destination-request", call, destination: { number: "+19990000000" } } }), deps, secret);
    expect(r.body).toMatchObject({ destination: { type: "number", number: "+13055550100" } });
  });
  it("tool-call results are returned keyed by toolCallId", async () => {
    const { deps } = world();
    const r = await handleVapiRequest(signed({ message: { type: "tool-calls", call, toolCallList: [{ id: "t1", function: { name: "revenue_desk_capture_intake", arguments: intakeArgs() } }] } }), deps, secret);
    const results = (r.body as any).results;
    expect(results[0].toolCallId).toBe("t1");
    expect(JSON.parse(results[0].result)).toMatchObject({ ok: true, saved: true });
  });
});

describe("Founder Beta usage allowance (500 min/month, metering only)", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const r = (created_at: string, minutes: number) => ({ created_at, duration_seconds: minutes * 60 });
  it("is exactly the Founder-approved 500 minutes", () => expect(FOUNDER_BETA_INCLUDED_MINUTES).toBe(500));
  it("counts only the current month and classifies within/approaching/exceeded", () => {
    expect(computeAllowance([r("2026-09-30T23:00:00Z", 999), r("2026-10-02T00:00:00Z", 100)], now)).toMatchObject({ usedMinutes: 100, state: "within", percentUsed: 20 });
    expect(computeAllowance([r("2026-10-02T00:00:00Z", 400)], now).state).toBe("approaching");
    expect(computeAllowance([r("2026-10-02T00:00:00Z", 501)], now)).toMatchObject({ state: "exceeded", usedMinutes: 501 });
  });
  it("has no cutoff path: the call/tool layer never reads the allowance", () => {
    const src = strip(readFileSync(join(__dirname, "service.ts"), "utf8")) + strip(readFileSync(join(__dirname, "..", "integrations", "vapi", "handler.ts"), "utf8"));
    expect(src).not.toMatch(/allowance|includedMinutes|FOUNDER_BETA_INCLUDED_MINUTES/i);
  });
});

describe("read model", () => {
  it("summarizes calls and only reports cost when the provider supplied it", () => {
    const s = summarizeCalls([
      { id: "1", created_at: "", status: "booked", priority: "routine", service_category: null, booking_outcome: "confirmed", escalation_result: null, duration_seconds: 120, provider_cost_usd: "0.24", failure_category: null, lead_id: null, intake: null },
      { id: "2", created_at: "", status: "escalated", priority: null, service_category: null, booking_outcome: null, escalation_result: "transferred", duration_seconds: 60, provider_cost_usd: null, failure_category: null, lead_id: null, intake: null },
    ]);
    expect(s).toMatchObject({ calls: 2, booked: 1, escalated: 1, failed: 0, minutes: 3, costUsd: 0.24, costPerMinute: 0.12 });
    expect(summarizeCalls([]).costUsd).toBeNull();
  });
});

// ------------------------------------------------------- authority freeze
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("authority freeze — Revenue Desk introduces no send/outbound path", () => {
  const root = join(__dirname, "..", "..");
  const files = [
    ...walk(join(root, "lib", "revenueDesk")),
    ...walk(join(root, "lib", "integrations", "vapi")),
    ...walk(join(root, "app", "api", "integrations", "vapi")),
    ...walk(join(root, "app", "(app)", "revenue-desk")),
  ].filter((f) => !f.endsWith(".test.ts"));

  it("scans a non-trivial file set", () => expect(files.length).toBeGreaterThanOrEqual(12));
  it.each([
    ["sendSms", /\bsendSms\b/],
    ["sendEmail", /\bsendEmail\b/],
    ["twilio module", /lib\/sms\/twilio/],
    ["resend module", /lib\/email\/resend/],
    ["legacy messaging modules", /lib\/modules\/(missedCallRecovery|estimateFollowup)/],
    ["outbound calls", /outbound|calls\.create|\/Calls\.json/i],
    ["Vapi SMS", /\bsms\b/i],
  ])("no %s", (_label, pattern) => {
    for (const f of files) expect(strip(readFileSync(f, "utf8")), f).not.toMatch(pattern);
  });
  it("Google events are created with sendUpdates none (no attendee email)", () => {
    const src = strip(readFileSync(join(root, "lib", "revenueDesk", "calendar", "google.ts"), "utf8"));
    expect(src).toMatch(/sendUpdates: "none"/);
    expect(src).not.toMatch(/attendees/);
  });
  it("Estimate Closing authority is unchanged: tool-less, no write scopes, inactive", async () => {
    const { ensureEstimateClosingAgent } = await import("@/lib/agents/estimateClosing/registration");
    const created: any[] = [];
    await ensureEstimateClosingAgent(T_A, { createIfAbsent: async (i: any) => { created.push(i); return { agent: i, created: true }; } });
    expect(created[0]).toMatchObject({ agentType: "estimate_closing", status: "inactive", allowedTools: [], writeScopes: [], approvalPolicy: {} });
  });
});
