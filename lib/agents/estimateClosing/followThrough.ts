import { createHash } from "crypto";
import { BusinessEventStore, SupabaseBusinessEventStore } from "@/lib/events/store";
import { emitEvent } from "@/lib/events/service";
import {
  FOLLOWTHROUGH_ACTION_TAKEN,
  FOLLOWTHROUGH_ACTION_CHANNEL,
  FOLLOWTHROUGH_CUSTOMER_RESPONSE,
  FOLLOWTHROUGH_BUSINESS_DISPOSITION,
  FollowThroughActionTaken,
  FollowThroughActionChannel,
  FollowThroughCustomerResponse,
  FollowThroughBusinessDisposition,
  EstimateClosingRecommendationFollowThrough,
  parsePersistedFollowThroughPayload,
} from "./followThroughTypes";

export { parsePersistedFollowThroughPayload };

/**
 * P1 Sprint 6 — records what the OWNER observed happened after a Shadow
 * recommendation: did they act on it, how, did the customer respond, and
 * what the current business result is. This is OWNER-RECORDED EVIDENCE,
 * never an approval, never an agent action, never an outcome, and never
 * recovered revenue — no code path here writes to `outcomes`, mutates a
 * lead, sends anything to a customer, or invokes a tool. See
 * followThroughTypes.ts's doc comment and OUTCOME_ATTRIBUTION.md.
 *
 * Constitutional attribution rule (P1 Sprint 6 directive §3), enforced
 * structurally by this module never writing anything beyond the four
 * enumerated fields below:
 *   AI recommendation != owner review != owner action != customer response
 *   != estimate won != AI-caused revenue. No stage may automatically imply
 * the next — this module stores OBSERVATIONS, never manufactures causation.
 *
 * Idempotency / correction model (P1 Sprint 6 directive §8) — a DELIBERATE
 * departure from review.ts's single-canonical-event pattern, decided here
 * because business_events has no update path (BusinessEventStore is
 * insert/list/getById only — see lib/events/store.ts) and because,
 * unlike a recommendation review (a one-time verdict), a real follow-through
 * story legitimately evolves: "later" today can genuinely become "yes" +
 * a business result next week. Two options were possible (directive §8):
 *   A. immutable first record + explicit correction event (append-only)
 *   B. deterministic replace/update semantics
 * Chose A: every submission is its own new business_events row (matching
 * how business_events is designed as an immutable append-only log
 * everywhere else in this codebase — see EVENT_SYSTEM.md), and the READ
 * side (commercialEvidence.ts / recommendationEvidence.ts) resolves
 * "current" state as the MOST RECENT follow-through event for a given
 * recommendation, exactly mirroring how scanTelemetry's "latest wins" read
 * discipline already works (operationsReadModel.ts).
 *
 * The idempotency key is content-derived — NOT simply
 * `<eventType>:<recommendationEventId>` (which would collapse every
 * correction to the SAME row, defeating the append-only design the
 * directive prefers) — so a genuine duplicate/retry (identical payload)
 * dedupes to one row, while an actual correction (different answer)
 * creates a new, additional row: `estimate.closing_recommendation_
 * followthrough_recorded:<recommendationEventId>:<sha256 of the four
 * submitted fields>`. This is a deliberate, reported architectural choice
 * (P1 Sprint 6 directive §8's "Report the decision"), not an ad hoc
 * mutation of the event system's own immutability contract.
 */

export type RecordFollowThroughInput = {
  recommendationEventId: string;
  actionTaken: unknown;
  actionChannel: unknown;
  customerResponse: unknown;
  businessDisposition: unknown;
};

export type FollowThroughRecordError =
  | "invalid_action_taken"
  | "invalid_action_channel"
  | "invalid_customer_response"
  | "invalid_business_disposition"
  | "recommendation_not_found"
  | "wrong_event_type";

export type RecordFollowThroughResult =
  | { ok: true; followThrough: EstimateClosingRecommendationFollowThrough; occurredAt: string; deduped: boolean }
  | { ok: false; error: FollowThroughRecordError };

const ACTION_TAKEN_VALUES = new Set<string>(FOLLOWTHROUGH_ACTION_TAKEN);
const ACTION_CHANNEL_VALUES = new Set<string>(FOLLOWTHROUGH_ACTION_CHANNEL);
const CUSTOMER_RESPONSE_VALUES = new Set<string>(FOLLOWTHROUGH_CUSTOMER_RESPONSE);
const BUSINESS_DISPOSITION_VALUES = new Set<string>(FOLLOWTHROUGH_BUSINESS_DISPOSITION);

/**
 * Pure, exported for direct unit testing — validates the caller-supplied
 * shape strictly, rejecting (never coercing, never silently dropping)
 * anything outside the enumerated sets. Enforces the ONE semantic coherence
 * rule the directive requires (§7): `actionChannel` is REQUIRED (must be a
 * valid channel) when `actionTaken === "yes"`, and must be null for
 * "no"/"later" — never silently accepted as if it meant something. Any
 * other field present in the raw input (a free-text note, a customer name,
 * anything) is simply never read — there is no code path here that could
 * persist it.
 */
export function validateFollowThroughInput(
  input: Pick<RecordFollowThroughInput, "actionTaken" | "actionChannel" | "customerResponse" | "businessDisposition">
):
  | {
      ok: true;
      value: {
        actionTaken: FollowThroughActionTaken;
        actionChannel: FollowThroughActionChannel | null;
        customerResponse: FollowThroughCustomerResponse;
        businessDisposition: FollowThroughBusinessDisposition;
      };
    }
  | { ok: false; error: FollowThroughRecordError } {
  if (typeof input.actionTaken !== "string" || !ACTION_TAKEN_VALUES.has(input.actionTaken)) {
    return { ok: false, error: "invalid_action_taken" };
  }
  const actionTaken = input.actionTaken as FollowThroughActionTaken;

  let actionChannel: FollowThroughActionChannel | null;
  if (actionTaken === "yes") {
    if (typeof input.actionChannel !== "string" || !ACTION_CHANNEL_VALUES.has(input.actionChannel)) {
      return { ok: false, error: "invalid_action_channel" };
    }
    actionChannel = input.actionChannel as FollowThroughActionChannel;
  } else {
    if (input.actionChannel !== null && input.actionChannel !== undefined) {
      return { ok: false, error: "invalid_action_channel" };
    }
    actionChannel = null;
  }

  if (typeof input.customerResponse !== "string" || !CUSTOMER_RESPONSE_VALUES.has(input.customerResponse)) {
    return { ok: false, error: "invalid_customer_response" };
  }
  if (typeof input.businessDisposition !== "string" || !BUSINESS_DISPOSITION_VALUES.has(input.businessDisposition)) {
    return { ok: false, error: "invalid_business_disposition" };
  }

  return {
    ok: true,
    value: {
      actionTaken,
      actionChannel,
      customerResponse: input.customerResponse as FollowThroughCustomerResponse,
      businessDisposition: input.businessDisposition as FollowThroughBusinessDisposition,
    },
  };
}

/** Deterministic — the SAME recommendation + the SAME four answers always
 * produces the SAME key (a true retry dedupes), while a DIFFERENT answer
 * (a genuine correction) always produces a DIFFERENT key (a new, additional
 * evidence row is created, never an in-place mutation). See this module's
 * top-level doc comment for the full architectural decision.
 *
 * TIME-BUCKETED, not purely content-derived (Codex review finding on PR
 * #25, P1): a pure content hash breaks the very sequence this design exists
 * to support — owner records A, corrects to B, later corrects BACK to A.
 * That third submission's content is byte-identical to the FIRST, so a
 * content-only key would collide with the original A event's key; the
 * unique index would then dedupe the third submission to that stale row
 * (with the ORIGINAL, now-wrong occurredAt), and the "latest wins" reader
 * would keep reporting B — an HTTP success that silently failed to record
 * the correction. Bucketing `nowMs` into the key (a coarse, injectable
 * clock) fixes this: two submissions of the same content within the SAME
 * short window (an accidental double-click, a network-level retry) still
 * dedupe to one row, but any later resubmission — even with identical
 * content — falls in a different bucket and is correctly treated as its
 * own new, current event. */
const FOLLOWTHROUGH_DEDUPE_WINDOW_MS = 5000;

export function buildFollowThroughIdempotencyKey(recommendationEventId: string, value: EstimateClosingRecommendationFollowThrough, nowMs: number): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        actionTaken: value.actionTaken,
        actionChannel: value.actionChannel,
        customerResponse: value.customerResponse,
        businessDisposition: value.businessDisposition,
      })
    )
    .digest("hex")
    .slice(0, 16);
  const bucket = Math.floor(nowMs / FOLLOWTHROUGH_DEDUPE_WINDOW_MS);
  return `estimate.closing_recommendation_followthrough_recorded:${recommendationEventId}:${digest}:${bucket}`;
}

/**
 * Records the tenant owner's observation of what happened after a
 * previously-generated shadow recommendation. `tenantId`/`actorUserId` are
 * plain parameters — mirrors review.ts::recordEstimateClosingRecommendationReview
 * exactly, for the identical reason: this core stays pure and
 * store-injectable for testing; the production-facing API route resolves
 * both from trusted session context (see followThroughRoute.ts), never from
 * anything a caller could forge in the request body.
 *
 * Owner-only enforcement happens at the route layer (matching review.ts's
 * own convention). This function's own safety guarantee is narrower and
 * unconditional: it can only ever emit ONE event type, with a fully
 * enumerated payload, and has NO dependency on any lead/outcome/approval/
 * tool-call store — there is no code path here through which recording
 * follow-through could mutate a lead, create an outcome, create an
 * approval, or invoke a tool, regardless of who calls it or what role they
 * hold. (Gate 10/11 of the P1 Sprint 6 directive.)
 */
export async function recordEstimateClosingRecommendationFollowThrough(
  tenantId: string,
  actorUserId: string,
  input: RecordFollowThroughInput,
  deps: { eventStore?: BusinessEventStore; now?: () => number } = {}
): Promise<RecordFollowThroughResult> {
  const eventStore = deps.eventStore ?? new SupabaseBusinessEventStore();
  const now = deps.now ?? (() => Date.now());

  const validated = validateFollowThroughInput(input);
  if (!validated.ok) return validated;

  // Tenant-scoped by construction: BusinessEventStore.getById filters by
  // tenant_id, so a recommendationEventId belonging to another tenant (or
  // that doesn't exist at all) returns null either way — same
  // non-enumerating posture as review.ts.
  const recommendationEvent = await eventStore.getById(tenantId, input.recommendationEventId);
  if (!recommendationEvent) {
    return { ok: false, error: "recommendation_not_found" };
  }
  if (recommendationEvent.eventType !== "estimate.closing_recommendation_generated") {
    return { ok: false, error: "wrong_event_type" };
  }

  const followThrough: EstimateClosingRecommendationFollowThrough = {
    recommendationEventId: recommendationEvent.id,
    actionTaken: validated.value.actionTaken,
    actionChannel: validated.value.actionChannel,
    customerResponse: validated.value.customerResponse,
    businessDisposition: validated.value.businessDisposition,
  };

  // A single clock read, used consistently for both the idempotency-key
  // bucket and the persisted occurredAt — never two independent reads that
  // could otherwise drift apart across a bucket boundary.
  const nowMs = now();

  const { event: persistedEvent, deduped } = await emitEvent(
    {
      tenantId,
      eventType: "estimate.closing_recommendation_followthrough_recorded",
      actorType: "user",
      actorId: actorUserId,
      entityType: recommendationEvent.entityType,
      entityId: recommendationEvent.entityId,
      causationId: recommendationEvent.id,
      idempotencyKey: buildFollowThroughIdempotencyKey(recommendationEvent.id, followThrough, nowMs),
      occurredAt: new Date(nowMs).toISOString(),
      payload: followThrough as unknown as Record<string, unknown>,
    },
    eventStore
  );

  // On the dedup path (an exact-content retry), reflect the ORIGINAL
  // persisted event's own occurredAt/value rather than assuming this call's
  // — same discipline as review.ts's identical dedup handling.
  if (deduped) {
    const original = parsePersistedFollowThroughPayload(persistedEvent.payload);
    if (original.ok) {
      return { ok: true, followThrough: original.value, occurredAt: persistedEvent.occurredAt, deduped: true };
    }
  }

  return { ok: true, followThrough, occurredAt: persistedEvent.occurredAt, deduped };
}

export function describeFollowThroughError(error: FollowThroughRecordError): string {
  switch (error) {
    case "invalid_action_taken":
      return `actionTaken must be one of: ${FOLLOWTHROUGH_ACTION_TAKEN.join(", ")}`;
    case "invalid_action_channel":
      return "actionChannel must be a valid channel when actionTaken is 'yes', and must be omitted otherwise";
    case "invalid_customer_response":
      return `customerResponse must be one of: ${FOLLOWTHROUGH_CUSTOMER_RESPONSE.join(", ")}`;
    case "invalid_business_disposition":
      return `businessDisposition must be one of: ${FOLLOWTHROUGH_BUSINESS_DISPOSITION.join(", ")}`;
    case "recommendation_not_found":
      return "recommendation not found";
    case "wrong_event_type":
      return "the referenced event is not an Estimate Closing recommendation";
  }
}
