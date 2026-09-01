import { BusinessEventStore, SupabaseBusinessEventStore } from "@/lib/events/store";
import { emitEvent } from "@/lib/events/service";
import { parsePersistedRecommendationPayload } from "./recommendationReadModel";
import { REVIEW_VERDICTS, REVIEW_WOULD_ACT, REVIEW_REASON_CODES, ReviewVerdict, ReviewWouldAct, ReviewReasonCode, EstimateClosingRecommendationReview, parsePersistedReviewPayload } from "./reviewTypes";

/**
 * P1 Sprint 3 — owner feedback on a Shadow recommendation. This is
 * evaluation EVIDENCE, not an outcome, not an approval, not a customer
 * action, and it never modifies the recommendation event or the lead it
 * concerns. See lib/events/types.ts's "estimate.closing_recommendation_reviewed"
 * doc comment and lib/events/contracts.ts's registered contract.
 *
 * Enumerated feedback only — no free text is ever accepted or persisted
 * (P1 Sprint 3 directive §5): a corrupted/hand-crafted request with an
 * unrecognized verdict, wouldAct, or reasonCode is rejected outright, the
 * same "fail conservatively on anything malformed" discipline
 * modelContract.ts and recommendationReadModel.ts already apply.
 *
 * The verdict/wouldAct/reasonCode enums and the persisted review shape
 * live in ./reviewTypes.ts (a dependency-free module) and are re-exported
 * here — see that file's doc comment for why: this module transitively
 * imports next/headers (via SupabaseBusinessEventStore) and can never be
 * imported into client-bundled code, but the enums themselves must be
 * safely importable by components/ai/ReviewControls.tsx (a Client
 * Component).
 */

export { REVIEW_VERDICTS, REVIEW_WOULD_ACT, REVIEW_REASON_CODES };
export type { ReviewVerdict, ReviewWouldAct, ReviewReasonCode, EstimateClosingRecommendationReview };

/** What a caller supplies, pre-validation — every field arrives as
 * `unknown` because it originates from an HTTP request body. */
export type RecordReviewInput = {
  recommendationEventId: string;
  verdict: unknown;
  wouldAct: unknown;
  reasonCodes: unknown;
};

export type ReviewRecordError =
  | "invalid_verdict"
  | "invalid_would_act"
  | "invalid_reason_codes"
  | "recommendation_not_found"
  | "wrong_event_type";

export type RecordReviewResult =
  | { ok: true; review: EstimateClosingRecommendationReview; alreadyReviewed: boolean }
  | { ok: false; error: ReviewRecordError };

const VERDICT_VALUES = new Set<string>(REVIEW_VERDICTS);
const WOULD_ACT_VALUES = new Set<string>(REVIEW_WOULD_ACT);
const REASON_CODE_VALUES = new Set<string>(REVIEW_REASON_CODES);

/** Pure, exported for direct unit testing — validates the caller-supplied
 * shape strictly, rejecting (never coercing or silently dropping) anything
 * outside the enumerated sets. An empty reasonCodes array is valid — the
 * owner is never required to give a reason. */
export function validateReviewInput(
  input: Pick<RecordReviewInput, "verdict" | "wouldAct" | "reasonCodes">
): { ok: true; value: { verdict: ReviewVerdict; wouldAct: ReviewWouldAct; reasonCodes: ReviewReasonCode[] } } | { ok: false; error: ReviewRecordError } {
  if (typeof input.verdict !== "string" || !VERDICT_VALUES.has(input.verdict)) {
    return { ok: false, error: "invalid_verdict" };
  }
  if (typeof input.wouldAct !== "string" || !WOULD_ACT_VALUES.has(input.wouldAct)) {
    return { ok: false, error: "invalid_would_act" };
  }
  if (!Array.isArray(input.reasonCodes) || input.reasonCodes.some((c) => typeof c !== "string" || !REASON_CODE_VALUES.has(c))) {
    return { ok: false, error: "invalid_reason_codes" };
  }
  return {
    ok: true,
    value: {
      verdict: input.verdict as ReviewVerdict,
      wouldAct: input.wouldAct as ReviewWouldAct,
      reasonCodes: input.reasonCodes as ReviewReasonCode[],
    },
  };
}

/** Deterministic — the SAME recommendation always produces the same key,
 * which is what makes "a single canonical review per recommendation" a
 * property of the existing (tenant_id, idempotency_key) unique index
 * (migration 009) rather than something a new migration is needed for. A
 * second review attempt on an already-reviewed recommendation dedupes to
 * the ORIGINAL row (`alreadyReviewed: true` below) instead of creating a
 * second one — evaluation evidence is append-only, not editable, in this
 * sprint. */
function buildReviewIdempotencyKey(recommendationEventId: string): string {
  return `estimate.closing_recommendation_reviewed:${recommendationEventId}`;
}

/**
 * Records the tenant owner's verdict on a previously-generated shadow
 * recommendation. `tenantId`/`actorUserId` are plain parameters — by
 * design, mirroring lib/approvals/service.ts::approveApproval — so this
 * core stays pure and store-injectable for testing; the production-facing
 * API route resolves both from trusted session context before calling
 * this (see lib/agents/estimateClosing/reviewRoute.ts), never from
 * anything a caller could forge in the request body.
 *
 * Deliberately does NOT take a role parameter or check it — owner-only
 * enforcement happens at the route layer (matching leads/[id]/route.ts and
 * app/api/tenant/profile/route.ts's convention for single-call-site
 * mutations, rather than approvals' AsAuthenticatedActor wrapper, which
 * exists there because approve/reject have multiple call sites). This
 * function's own safety guarantee is narrower and unconditional: it can
 * only ever emit ONE event type, with a fully-enumerated payload, and has
 * no dependency on any lead/outcome/approval/tool-call store — there is no
 * code path here through which a review could mutate a lead, create an
 * outcome, create an approval, or invoke a tool, regardless of who calls
 * it or what role they hold.
 */
export async function recordEstimateClosingRecommendationReview(
  tenantId: string,
  actorUserId: string,
  input: RecordReviewInput,
  deps: { eventStore?: BusinessEventStore } = {}
): Promise<RecordReviewResult> {
  const eventStore = deps.eventStore ?? new SupabaseBusinessEventStore();

  const validated = validateReviewInput(input);
  if (!validated.ok) return validated;

  // Tenant-scoped by construction: BusinessEventStore.getById filters by
  // tenant_id, so a recommendationEventId belonging to another tenant (or
  // that doesn't exist at all) returns null either way — this function
  // never lets a caller distinguish "wrong tenant" from "doesn't exist",
  // the same non-enumerating posture lib/approvals/service.ts's
  // resolveApprovalActor and app/auth/forgot-password already establish.
  const recommendationEvent = await eventStore.getById(tenantId, input.recommendationEventId);
  if (!recommendationEvent) {
    return { ok: false, error: "recommendation_not_found" };
  }
  if (recommendationEvent.eventType !== "estimate.closing_recommendation_generated") {
    return { ok: false, error: "wrong_event_type" };
  }

  const parsedRecommendation = parsePersistedRecommendationPayload(recommendationEvent.payload);
  const agentRunId = parsedRecommendation.ok ? parsedRecommendation.value.agentRunId : null;

  const review: EstimateClosingRecommendationReview = {
    recommendationEventId: recommendationEvent.id,
    agentRunId,
    verdict: validated.value.verdict,
    wouldAct: validated.value.wouldAct,
    reasonCodes: validated.value.reasonCodes,
  };

  const { event: persistedEvent, deduped } = await emitEvent(
    {
      tenantId,
      eventType: "estimate.closing_recommendation_reviewed",
      actorType: "user",
      actorId: actorUserId,
      entityType: recommendationEvent.entityType,
      entityId: recommendationEvent.entityId,
      causationId: recommendationEvent.id,
      idempotencyKey: buildReviewIdempotencyKey(recommendationEvent.id),
      payload: review as unknown as Record<string, unknown>,
    },
    eventStore
  );

  // On the dedup path, `persistedEvent` is the ORIGINAL review, not this
  // call's own (possibly different, and in that case correctly discarded)
  // attempt — parse it back rather than returning the locally-built
  // `review` unconditionally, so a caller who races a second review never
  // sees their own rejected verdict reflected back as if it had won.
  if (deduped) {
    const original = parsePersistedReviewPayload(persistedEvent.payload);
    if (original.ok) {
      return { ok: true, review: original.value, alreadyReviewed: true };
    }
    // Defensive fallback only — the original event was written by this
    // same function, so its payload should always parse; if it somehow
    // doesn't (e.g. hand-edited data), still report the dedup honestly
    // rather than silently substituting the caller's own attempt.
  }

  return { ok: true, review, alreadyReviewed: deduped };
}

export function describeReviewError(error: ReviewRecordError): string {
  switch (error) {
    case "invalid_verdict":
      return `verdict must be one of: ${REVIEW_VERDICTS.join(", ")}`;
    case "invalid_would_act":
      return `wouldAct must be one of: ${REVIEW_WOULD_ACT.join(", ")}`;
    case "invalid_reason_codes":
      return `reasonCodes must only contain: ${REVIEW_REASON_CODES.join(", ")}`;
    case "recommendation_not_found":
      return "recommendation not found";
    case "wrong_event_type":
      return "the referenced event is not an Estimate Closing recommendation";
  }
}
