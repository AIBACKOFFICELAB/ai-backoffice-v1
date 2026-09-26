import { EstimateClosingRecommendationEvidence } from "./recommendationEvidence";
import { BUSINESS_DISPOSITION_LABELS } from "./followThroughTypes";

/**
 * P1 Sprint 7 §7/§8 — the canonical estimate lifecycle timeline. A PURE
 * presentation read model: it never fetches anything itself and never
 * fabricates a stage or a timestamp. It combines exactly what
 * getEstimateClosingRecommendationEvidence() already assembled (see that
 * module's own doc comment on why every relation it can't resolve is
 * labeled unavailable/null rather than guessed) into one ordered, narrated
 * sequence for the recommendation evidence page (§8's "the user should be
 * able to understand the entire story without reconstructing it from
 * multiple pages").
 *
 * A stage whose underlying evidence doesn't exist is marked "pending" (it
 * simply hasn't happened, or hasn't been recorded yet) — never given a
 * fabricated timestamp, and never silently omitted (an operator seeing a
 * gap should be able to tell "this hasn't happened" from "the product
 * forgot to check"). Ordering follows the DIRECTIVE'S own stage list
 * (§7) exactly.
 */

export type TimelineStageKind =
  | "lead_received"
  | "estimate_sent"
  | "day1_followup"
  | "day3_followup"
  | "day7_followup"
  | "estimate_stalled"
  | "shadow_recommendation_generated"
  | "owner_review_recorded"
  | "owner_followthrough_recorded"
  | "current_business_disposition";

export type TimelineStageStatus = "completed" | "pending";

export type TimelineStage = {
  kind: TimelineStageKind;
  status: TimelineStageStatus;
  /** ISO timestamp when this stage completed — null while status is
   * "pending". */
  occurredAt: string | null;
  /** Short business-language title, e.g. "Estimate sent". */
  label: string;
  /** One-line supporting detail, e.g. "55% confidence" or "Agree". Null
   * when there is nothing further to say. */
  detail: string | null;
};

type EvidenceFound = Extract<EstimateClosingRecommendationEvidence, { found: true }>;

function reviewDetail(review: EvidenceFound["review"]): string | null {
  if (!review) return null;
  const verdictLabel = review.verdict.charAt(0).toUpperCase() + review.verdict.slice(1);
  const wouldActLabel = review.wouldAct === "yes" ? "Would act" : review.wouldAct === "no" ? "Would not act" : "Would act later";
  return `${verdictLabel} · Intent: ${wouldActLabel}`;
}

function followThroughDetail(followThrough: EvidenceFound["followThrough"]): string | null {
  if (!followThrough) return null;
  if (followThrough.actionTaken !== "yes") {
    return `Action taken: ${followThrough.actionTaken === "no" ? "No" : "Later"}`;
  }
  return `Action taken · Channel: ${followThrough.actionChannel ?? "Unknown"}`;
}

function dispositionDetail(followThrough: EvidenceFound["followThrough"]): string | null {
  if (!followThrough) return null;
  return `Owner-reported: ${BUSINESS_DISPOSITION_LABELS[followThrough.businessDisposition]}`;
}

/**
 * Pure. `evidence` must be the `{ found: true }` branch — callers check
 * `found` before calling this (mirrors every other consumer of
 * getEstimateClosingRecommendationEvidence's result shape).
 */
export function buildEstimateClosingEvidenceTimeline(evidence: EvidenceFound): TimelineStage[] {
  const stages: TimelineStage[] = [];

  stages.push({
    kind: "lead_received",
    status: evidence.leadReceivedAt ? "completed" : "pending",
    occurredAt: evidence.leadReceivedAt,
    label: "Lead received",
    detail: null,
  });

  stages.push({
    kind: "estimate_sent",
    status: evidence.sequence?.estimateSentAt ? "completed" : "pending",
    occurredAt: evidence.sequence?.estimateSentAt ?? null,
    label: "Estimate sent",
    detail: null,
  });

  stages.push({
    kind: "day1_followup",
    status: evidence.sequence?.day1SentAt ? "completed" : "pending",
    occurredAt: evidence.sequence?.day1SentAt ?? null,
    label: "Day 1 follow-up",
    detail: null,
  });

  stages.push({
    kind: "day3_followup",
    status: evidence.sequence?.day3SentAt ? "completed" : "pending",
    occurredAt: evidence.sequence?.day3SentAt ?? null,
    label: "Day 3 follow-up",
    detail: null,
  });

  stages.push({
    kind: "day7_followup",
    status: evidence.sequence?.day7SentAt ? "completed" : "pending",
    occurredAt: evidence.sequence?.day7SentAt ?? null,
    label: "Day 7 follow-up",
    detail: null,
  });

  stages.push({
    kind: "estimate_stalled",
    status: evidence.stalledEventFound ? "completed" : "pending",
    occurredAt: evidence.stalledEventOccurredAt,
    label: "Estimate stalled",
    detail: evidence.stalledEventFound ? "No reply after the follow-up sequence" : null,
  });

  stages.push({
    kind: "shadow_recommendation_generated",
    status: "completed",
    occurredAt: evidence.recommendation.occurredAt,
    label: "Shadow recommendation generated",
    detail: `${Math.round(evidence.recommendation.confidence * 100)}% confidence`,
  });

  stages.push({
    kind: "owner_review_recorded",
    status: evidence.review ? "completed" : "pending",
    occurredAt: evidence.review?.occurredAt ?? null,
    label: "Owner review",
    detail: reviewDetail(evidence.review),
  });

  stages.push({
    kind: "owner_followthrough_recorded",
    status: evidence.followThrough ? "completed" : "pending",
    occurredAt: evidence.followThroughOccurredAt,
    label: "Actual follow-through",
    detail: followThroughDetail(evidence.followThrough),
  });

  stages.push({
    kind: "current_business_disposition",
    status: evidence.followThrough ? "completed" : "pending",
    occurredAt: evidence.followThroughOccurredAt,
    label: "Current business disposition",
    detail: dispositionDetail(evidence.followThrough),
  });

  return stages;
}
