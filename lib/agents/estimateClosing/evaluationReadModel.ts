import { BusinessEventStore, SupabaseBusinessEventStore } from "@/lib/events/store";
import { BusinessEvent } from "@/lib/events/types";
import { AgentRunStore, SupabaseAgentRunStore } from "@/lib/agents/runStore";
import { listEstimateClosingRecommendations, EstimateClosingRecommendationView } from "./recommendationReadModel";
import { REVIEW_REASON_CODES, ReviewReasonCode, EstimateClosingRecommendationReview, parsePersistedReviewPayload } from "./reviewTypes";
import { ESTIMATE_CLOSING_REASON_CODES, EstimateClosingReasonCode } from "./types";
import { ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID } from "./mode";

export { parsePersistedReviewPayload };

/**
 * P1 Sprint 3 — the dedicated read model that answers "when Estimate
 * Closing produces real recommendations, are they actually good?" (the
 * sprint's stated commercial question). Reads ONLY
 * estimate.closing_recommendation_generated and
 * estimate.closing_recommendation_reviewed business events, plus a bounded
 * agent_runs read for model-failure counting — nothing here is an outcome,
 * nothing here authorizes an action, and nothing here claims recovered
 * revenue (see lib/agents/estimateClosing/review.ts's own doc comment and
 * OUTCOME_ATTRIBUTION.md).
 *
 * Same bounded-window honesty discipline as recommendationReadModel.ts:
 * every number here reflects the most recent DEFAULT_LIMIT events, not a
 * lifetime total. A sample size of zero is reported as zero/null, never
 * dressed up as a percentage — see agreementRate below and the UI's own
 * "Not enough evidence yet" copy (app/(app)/agentic/estimate-closing/page.tsx).
 */

const DEFAULT_LIMIT = 200;

export type EstimateClosingRecommendationReviewView = EstimateClosingRecommendationReview & {
  reviewEventId: string;
  occurredAt: string;
};

export type ListEstimateClosingRecommendationReviewsResult = {
  reviews: EstimateClosingRecommendationReviewView[];
  skippedMalformed: number;
};

function toReviewView(event: BusinessEvent): EstimateClosingRecommendationReviewView | null {
  const parsed = parsePersistedReviewPayload(event.payload);
  if (!parsed.ok) return null;
  return { ...parsed.value, reviewEventId: event.id, occurredAt: event.occurredAt };
}

/** Reads ONLY estimate.closing_recommendation_reviewed events for this
 * tenant, bounded, most-recent-first. Mirrors
 * recommendationReadModel.ts::listEstimateClosingRecommendations exactly. */
export async function listEstimateClosingRecommendationReviews(
  tenantId: string,
  options: { limit?: number; eventStore?: BusinessEventStore } = {}
): Promise<ListEstimateClosingRecommendationReviewsResult> {
  const eventStore = options.eventStore ?? new SupabaseBusinessEventStore();
  const limit = options.limit ?? DEFAULT_LIMIT;

  const events = await eventStore.listByTenant(tenantId, { eventType: "estimate.closing_recommendation_reviewed", limit });

  const reviews: EstimateClosingRecommendationReviewView[] = [];
  let skippedMalformed = 0;
  for (const event of events) {
    const view = toReviewView(event);
    if (view) reviews.push(view);
    else skippedMalformed += 1;
  }
  return { reviews, skippedMalformed };
}

export type EvaluatedRecommendation = {
  recommendation: EstimateClosingRecommendationView;
  review: EstimateClosingRecommendationReviewView | null;
};

/** Pure — pairs each recommendation with its review, if any. Powers both
 * the aggregate evaluation metrics below AND the specialist workspace's
 * Recommendation Review Queue (which needs to show unreviewed
 * recommendations too, not just reviewed ones). */
export function pairRecommendationsWithReviews(
  recommendations: EstimateClosingRecommendationView[],
  reviews: EstimateClosingRecommendationReviewView[]
): EvaluatedRecommendation[] {
  const byRecommendationId = new Map(reviews.map((r) => [r.recommendationEventId, r]));
  return recommendations.map((recommendation) => ({ recommendation, review: byRecommendationId.get(recommendation.recommendationEventId) ?? null }));
}

export type ConfidenceBand = "low" | "medium" | "high";

/** Simple, documented bucketing — a display convenience, not a claim of
 * statistical significance. Adjustable without any downstream migration
 * since it operates only on already-fetched values. */
export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

function zeroRecord<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

export type EstimateClosingEvaluation = {
  recommendationsGenerated: number;
  /** Recommendations, within the current bounded window, that have a
   * matched review — NOT simply `reviews.length`, so this number is never
   * larger than recommendationsGenerated even in the edge case where a
   * review's target recommendation has aged out of the window. */
  recommendationsReviewed: number;
  agreeCount: number;
  disagreeCount: number;
  unsureCount: number;
  wouldActYes: number;
  wouldActNo: number;
  wouldActLater: number;
  /** null when recommendationsReviewed === 0 — "not enough evidence yet",
   * never a fabricated 0% or NaN. */
  agreementRate: number | null;
  /** null when recommendationsGenerated === 0. */
  averageConfidence: number | null;
  confidenceBandCounts: Record<ConfidenceBand, number>;
  recommendationBreakdown: { followUp: number; wait: number; ownerReview: number };
  /** Why the AI recommended what it did, across the window. */
  reasonCodeBreakdown: Record<EstimateClosingReasonCode, number>;
  /** Why the OWNER agreed/disagreed, across reviewed recommendations —
   * intentionally a separate breakdown from reasonCodeBreakdown above
   * (the model's reasoning vs. the owner's evaluation of it are different
   * signals; see the P1 Sprint 3 directive's "reason-code usefulness"
   * evaluation goal). */
  reviewReasonCodeBreakdown: Record<ReviewReasonCode, number>;
  /** Bounded count of agent_runs with workflowId ===
   * ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID and status 'failed', within the
   * same window. */
  modelFailureCount: number;
  opportunityValueAnalyzed: number;
  /** Most recent recommendation's occurredAt within the window, or null
   * when none exist. Mirrors
   * recommendationReadModel.ts::summarizeEstimateClosingRecommendations's
   * own field of the same name — computed here too so the specialist
   * workspace's "latest recommendation time" doesn't need a second read
   * model call. */
  latestRecommendationAt: string | null;
  skippedMalformedRecommendations: number;
  skippedMalformedReviews: number;
  /** Only the recommendations that have been reviewed. */
  reviewedRecommendations: EvaluatedRecommendation[];
  /** Every recommendation in the window, reviewed or not — what the
   * specialist workspace's Recommendation Review Queue renders. */
  recommendationsWithReviewStatus: EvaluatedRecommendation[];
  /**
   * Always 0 — shadowRunner.ts has no `toolPlan` parameter anywhere in its
   * signature and never imports the tool-call/approval runtime; there is
   * no code path through which Shadow Mode could ever create a tool_calls
   * row. A structural fact stated plainly, not a live query result — see
   * AGENT_SECURITY.md and shadowRunner.ts's own doc comment. Per the P1
   * Sprint 3 directive: "if architecture cannot reliably attribute a
   * metric... do not fake it. Label unavailable metrics honestly" — this
   * is the honest label, not an approximation.
   */
  toolCallsAttributable: 0;
  /** Always 0 — the same structural guarantee: nothing in shadowRunner.ts
   * ever calls requestApproval(), independent of the agent row's own
   * approvalPolicy configuration. */
  approvalsAttributable: 0;
  /** Always 0 — Shadow Mode's allowedTools is always [] and no
   * SEND-permission tool is registered or reachable from it. */
  customerActionsAttributable: 0;
};

export async function getEstimateClosingEvaluation(
  tenantId: string,
  options: { limit?: number; eventStore?: BusinessEventStore; runStore?: AgentRunStore } = {}
): Promise<EstimateClosingEvaluation> {
  const eventStore = options.eventStore ?? new SupabaseBusinessEventStore();
  const runStore = options.runStore ?? new SupabaseAgentRunStore();
  const limit = options.limit ?? DEFAULT_LIMIT;

  const [recommendationsResult, reviewsResult, runs] = await Promise.all([
    listEstimateClosingRecommendations(tenantId, { limit, eventStore }),
    listEstimateClosingRecommendationReviews(tenantId, { limit, eventStore }),
    runStore.listByTenant(tenantId, { limit }),
  ]);

  const pairs = pairRecommendationsWithReviews(recommendationsResult.recommendations, reviewsResult.reviews);
  const reviewedRecommendations = pairs.filter((p): p is EvaluatedRecommendation & { review: EstimateClosingRecommendationReviewView } => p.review !== null);

  let agreeCount = 0;
  let disagreeCount = 0;
  let unsureCount = 0;
  let wouldActYes = 0;
  let wouldActNo = 0;
  let wouldActLater = 0;
  const reviewReasonCodeBreakdown = zeroRecord(REVIEW_REASON_CODES);

  for (const { review } of reviewedRecommendations) {
    if (review.verdict === "agree") agreeCount += 1;
    else if (review.verdict === "disagree") disagreeCount += 1;
    else unsureCount += 1;

    if (review.wouldAct === "yes") wouldActYes += 1;
    else if (review.wouldAct === "no") wouldActNo += 1;
    else wouldActLater += 1;

    for (const code of review.reasonCodes) reviewReasonCodeBreakdown[code] += 1;
  }

  const agreementRate = reviewedRecommendations.length > 0 ? agreeCount / reviewedRecommendations.length : null;

  let confidenceSum = 0;
  const confidenceBandCounts: Record<ConfidenceBand, number> = { low: 0, medium: 0, high: 0 };
  const reasonCodeBreakdown = zeroRecord(ESTIMATE_CLOSING_REASON_CODES);
  let followUp = 0;
  let wait = 0;
  let ownerReview = 0;
  let opportunityValueAnalyzed = 0;
  let latestRecommendationAt: string | null = null;

  for (const rec of recommendationsResult.recommendations) {
    confidenceSum += rec.confidence;
    confidenceBandCounts[confidenceBand(rec.confidence)] += 1;
    if (rec.recommendation === "follow_up") followUp += 1;
    else if (rec.recommendation === "wait") wait += 1;
    else ownerReview += 1;
    for (const code of rec.reasonCodes) reasonCodeBreakdown[code] += 1;
    if (rec.opportunityValue != null) opportunityValueAnalyzed += rec.opportunityValue;
    if (latestRecommendationAt == null || rec.occurredAt > latestRecommendationAt) latestRecommendationAt = rec.occurredAt;
  }
  const averageConfidence = recommendationsResult.recommendations.length > 0 ? confidenceSum / recommendationsResult.recommendations.length : null;

  const modelFailureCount = runs.filter((run) => run.workflowId === ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID && run.status === "failed").length;

  return {
    recommendationsGenerated: recommendationsResult.recommendations.length,
    recommendationsReviewed: reviewedRecommendations.length,
    agreeCount,
    disagreeCount,
    unsureCount,
    wouldActYes,
    wouldActNo,
    wouldActLater,
    agreementRate,
    averageConfidence,
    confidenceBandCounts,
    recommendationBreakdown: { followUp, wait, ownerReview },
    reasonCodeBreakdown,
    reviewReasonCodeBreakdown,
    modelFailureCount,
    opportunityValueAnalyzed,
    latestRecommendationAt,
    skippedMalformedRecommendations: recommendationsResult.skippedMalformed,
    skippedMalformedReviews: reviewsResult.skippedMalformed,
    reviewedRecommendations,
    recommendationsWithReviewStatus: pairs,
    toolCallsAttributable: 0,
    approvalsAttributable: 0,
    customerActionsAttributable: 0,
  };
}
