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
 * The idempotency key is REQUEST-IDENTITY-derived, not business-content-
 * derived (P1 Sprint 6 final hardening, PR #25 — see buildFollowThroughIdempotencyKey's
 * own doc comment for the full history: content-only, then content+time-
 * bucketed, both proved to have a real collision case; a client-generated
 * `submissionId` is the only approach that separates REQUEST identity from
 * BUSINESS CONTENT cleanly). A genuine duplicate/retry of the exact same
 * Save action (same submissionId) dedupes to one row; a new Save/correction
 * action — even with byte-identical answers — always gets a NEW
 * submissionId from the client and therefore always creates a new,
 * additional row. This is a deliberate, reported architectural choice, not
 * an ad hoc mutation of the event system's own immutability contract.
 */

export type RecordFollowThroughInput = {
  recommendationEventId: string;
  actionTaken: unknown;
  actionChannel: unknown;
  customerResponse: unknown;
  businessDisposition: unknown;
  /** Client-generated request/transport identity — NOT business content,
   * NOT an authorization credential (tenant/recommendation ownership is
   * independently verified regardless of this value). One value per
   * explicit Save action; the client reuses it only when retrying that
   * SAME action after a transport failure. See
   * components/ai/FollowThroughControls.tsx and
   * buildFollowThroughIdempotencyKey's doc comment. */
  submissionId: unknown;
};

export type FollowThroughRecordError =
  | "invalid_action_taken"
  | "invalid_action_channel"
  | "invalid_customer_response"
  | "invalid_business_disposition"
  | "invalid_submission_id"
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

/**
 * History of this key's design (both prior attempts proved wrong by real
 * regression cases, kept here so the final choice isn't re-litigated):
 *   1. Pure content hash — collapsed a genuine A -> B -> A correction
 *      sequence, because the third submission's content is byte-identical
 *      to the first (Codex review finding on PR #25, P1).
 *   2. Content hash + a coarse time bucket — fixed THAT case only when the
 *      two A submissions land in different buckets; a legitimate RAPID
 *      A -> B -> A within one bucket still collided (founder architecture
 *      review, PR #25 final hardening).
 *   3. THIS version — pure request identity. `submissionId` is a value the
 *      CLIENT generates once per explicit Save action (see
 *      components/ai/FollowThroughControls.tsx) and reuses ONLY when
 *      retrying that same action after a transport failure. The server
 *      never inspects business content or a clock to decide whether two
 *      requests are "the same submission" — only whether `submissionId`
 *      matches. This is the only design that cleanly separates REQUEST
 *      identity from BUSINESS CONTENT: a true retry (same submissionId)
 *      always dedupes, regardless of timing; a new Save/correction action
 *      (a new submissionId) always creates a new, additional row,
 *      regardless of how soon it follows or how similar its content is.
 *
 * `submissionId` is NEVER used for authorization — tenant/recommendation
 * ownership is independently verified in
 * recordEstimateClosingRecommendationFollowThrough regardless of this
 * value; it is transport/idempotency identity only, never persisted as
 * business evidence (it lives in the idempotency_key column, not in the
 * payload — see the payload assembly below, which has no submissionId
 * field).
 */
export function buildFollowThroughIdempotencyKey(recommendationEventId: string, submissionId: string): string {
  return `estimate.closing_recommendation_followthrough_recorded:${recommendationEventId}:${submissionId}`;
}

/** Bounded shape check only — this is transport identity, not a trust
 * decision, so validation stays intentionally shallow: a non-empty string
 * of reasonable length restricted to characters `crypto.randomUUID()` (or
 * an equivalent UUID-shaped generator) actually produces. Never a strict
 * UUID-v4 regex — the exact generator is a client concern (see
 * FollowThroughControls.tsx), not a contract this server-side check should
 * over-constrain. */
const SUBMISSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export function validateSubmissionId(value: unknown): value is string {
  return typeof value === "string" && SUBMISSION_ID_PATTERN.test(value);
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

  if (!validateSubmissionId(input.submissionId)) {
    return { ok: false, error: "invalid_submission_id" };
  }
  const submissionId = input.submissionId;

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

  const { event: persistedEvent, deduped } = await emitEvent(
    {
      tenantId,
      eventType: "estimate.closing_recommendation_followthrough_recorded",
      actorType: "user",
      actorId: actorUserId,
      entityType: recommendationEvent.entityType,
      entityId: recommendationEvent.entityId,
      causationId: recommendationEvent.id,
      idempotencyKey: buildFollowThroughIdempotencyKey(recommendationEvent.id, submissionId),
      occurredAt: new Date(now()).toISOString(),
      payload: followThrough as unknown as Record<string, unknown>,
    },
    eventStore
  );

  // On the dedup path — a true retry of the SAME submissionId — reflect
  // the ORIGINAL persisted event's own occurredAt/value rather than
  // assuming this call's own (possibly-altered) content ever landed; the
  // idempotency key can never represent two different payloads, matching
  // how every other idempotency-keyed event type in this codebase already
  // behaves (see EVENT_SYSTEM.md) — same discipline as review.ts's
  // identical dedup handling. A caller that reuses a submissionId with
  // genuinely different content (a client bug, never expected in normal
  // use — see FollowThroughControls.tsx's own contract) silently gets the
  // FIRST submission's content back, never an error and never a mutation
  // of what was actually persisted; it is the client's responsibility to
  // mint a new submissionId for every new Save action.
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
    case "invalid_submission_id":
      return "submissionId is required and must be a bounded identifier";
    case "recommendation_not_found":
      return "recommendation not found";
    case "wrong_event_type":
      return "the referenced event is not an Estimate Closing recommendation";
  }
}
