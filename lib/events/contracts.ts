/**
 * Lightweight event-contract registry for CURRENT P0 event types (P0.9
 * Slice C, finding M-04). Deliberately small — this is NOT a general event
 * platform: no schema-migration tooling, no dynamic registration, no
 * autonomous event-triggered-event execution. It exists to make three
 * things explicit and enforced for the event types this codebase actually
 * emits today:
 *
 *   1. a payload-privacy contract (see lib/events/service.ts::emitEvent,
 *      which enforces this on the governed path — never on the
 *      swallow-everything emitEventSafely path, per the "different trust
 *      boundaries" rule in lib/telemetry/deadline.ts);
 *   2. whether idempotency_key use is required/recommended/not applicable
 *      for a given event type, as documentation producers can check
 *      against;
 *   3. a schemaVersion so a FUTURE breaking payload-shape change to a
 *      contract is a visible, deliberate bump, not a silent drift.
 *
 * Replay/loop-protection posture for P0 (M-04): duplicate idempotency_key
 * emission returns the original row unchanged (enforced by the DB unique
 * index — migration 009 — and exercised in service.test.ts); nothing in
 * this codebase currently subscribes to business_events to automatically
 * emit further events, so there is no autonomous event loop to protect
 * against yet — that policy question is deferred until such a subscriber
 * exists (explicitly out of scope for Slice C).
 */

export type EventIdempotencyPolicy = "required" | "recommended" | "not_applicable";

export type EventPayloadValidation = { ok: true } | { ok: false; errors: string[] };

export type EventContract = {
  eventType: string;
  schemaVersion: number;
  idempotency: EventIdempotencyPolicy;
  /** Validates a payload against this event type's expected shape —
   * intentionally shallow (privacy rules + presence checks), mirroring
   * ToolDefinition.validateInput's { ok } shape for consistency rather
   * than pulling in a schema library for three event types. */
  validatePayload(payload: unknown): EventPayloadValidation;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Privacy-safe payload shape shared by every Missed Call Recovery
 * compat event (P0.9 Slice C, finding H-05/C.4): the caller's raw phone
 * number must never be duplicated into a canonical business-event
 * payload — the Lead record and missed_call_recovery_history are the
 * real systems of record for it. */
function forbidRawCallerPhone(payload: unknown): EventPayloadValidation {
  if (!isRecord(payload)) return { ok: false, errors: ["payload must be an object"] };
  if ("callerPhone" in payload) return { ok: false, errors: ["payload must not include raw callerPhone — see lib/events/contracts.ts"] };
  return { ok: true };
}

export const EVENT_CONTRACTS: Record<string, EventContract> = {
  "call.missed": {
    eventType: "call.missed",
    schemaVersion: 1,
    // Keyed by callSid when available (see lib/modules/missedCallRecovery/service.ts) —
    // Twilio callbacks can redeliver, so idempotency is recommended
    // whenever a callSid exists, not strictly required (a callSid-less
    // call still needs to be recorded once).
    idempotency: "recommended",
    validatePayload: forbidRawCallerPhone,
  },
  "lead.created": {
    eventType: "lead.created",
    schemaVersion: 1,
    // leadId itself (the event's entityId) is already a unique, durable
    // identity — no separate idempotency key is needed to dedupe this
    // event type.
    idempotency: "not_applicable",
    validatePayload: forbidRawCallerPhone,
  },
  "recovery.sms_sent": {
    eventType: "recovery.sms_sent",
    schemaVersion: 1,
    idempotency: "recommended",
    validatePayload: forbidRawCallerPhone,
  },
  "test.echo": {
    eventType: "test.echo",
    schemaVersion: 1,
    idempotency: "not_applicable",
    validatePayload: () => ({ ok: true }),
  },
};

export function getEventContract(eventType: string): EventContract | null {
  return EVENT_CONTRACTS[eventType] ?? null;
}
