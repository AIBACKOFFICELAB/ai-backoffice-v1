/**
 * P1 Sprint 3 — pure, dependency-free review enums/types shared by both the
 * server-side review service (review.ts, evaluationReadModel.ts) AND the
 * client-side review controls component (components/ai/ReviewControls.tsx).
 *
 * Deliberately has ZERO imports of its own — mirrors why
 * components/app-shell/navConfig.ts is safe to import from both a Server
 * Component (AppShell.tsx) and a Client Component (NavLinks.tsx): a module
 * that pulls in next/headers (transitively, via SupabaseBusinessEventStore
 * in review.ts/evaluationReadModel.ts) can never be imported into
 * client-bundled code without breaking the build. Enumerated feedback only
 * — no free-text field exists anywhere in this file, by construction.
 */

export const REVIEW_VERDICTS = ["agree", "disagree", "unsure"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_WOULD_ACT = ["yes", "no", "later"] as const;
export type ReviewWouldAct = (typeof REVIEW_WOULD_ACT)[number];

export const REVIEW_REASON_CODES = [
  "recommendation_correct",
  "timing_wrong",
  "channel_wrong",
  "not_real_opportunity",
  "insufficient_context",
  "confidence_too_high",
  "confidence_too_low",
  "other",
] as const;
export type ReviewReasonCode = (typeof REVIEW_REASON_CODES)[number];

/** The privacy-safe, persisted form of a review — what lands in the
 * estimate.closing_recommendation_reviewed event's payload and what the
 * evaluation read model consumes. Structurally has no field for free text,
 * a customer identifier, or raw model rationale — there is nowhere to put
 * one even by mistake. */
export type EstimateClosingRecommendationReview = {
  recommendationEventId: string;
  agentRunId: string | null;
  verdict: ReviewVerdict;
  wouldAct: ReviewWouldAct;
  reasonCodes: ReviewReasonCode[];
};

export const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  agree: "Agree",
  disagree: "Disagree",
  unsure: "Unsure",
};

export const WOULD_ACT_LABELS: Record<ReviewWouldAct, string> = {
  yes: "Would act",
  no: "Would not act",
  later: "Later",
};

export const REVIEW_REASON_CODE_LABELS: Record<ReviewReasonCode, string> = {
  recommendation_correct: "Recommendation was correct",
  timing_wrong: "Timing was wrong",
  channel_wrong: "Channel was wrong",
  not_real_opportunity: "Not a real opportunity",
  insufficient_context: "Insufficient context",
  confidence_too_high: "Confidence was too high",
  confidence_too_low: "Confidence was too low",
  other: "Other",
};

const VERDICT_VALUES = new Set<string>(REVIEW_VERDICTS);
const WOULD_ACT_VALUES = new Set<string>(REVIEW_WOULD_ACT);
const REASON_CODE_VALUES = new Set<string>(REVIEW_REASON_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict shape check against the PERSISTED review payload contract (see
 * review.ts::recordEstimateClosingRecommendationReview, the only writer).
 * Lives here — not in review.ts or evaluationReadModel.ts — so BOTH can
 * share exactly one implementation: review.ts needs it to reconstruct the
 * ACTUAL persisted review on the idempotent-dedup path (a second review
 * attempt must return the ORIGINAL review, not the caller's own discarded
 * attempt — see review.ts's doc comment), and evaluationReadModel.ts needs
 * it to read reviews back safely, never trusting historical/malformed
 * data. A malformed payload is reported as `{ ok: false }`, never thrown.
 */
export function parsePersistedReviewPayload(payload: unknown): { ok: true; value: EstimateClosingRecommendationReview } | { ok: false } {
  if (!isRecord(payload)) return { ok: false };
  if (typeof payload.recommendationEventId !== "string" || !payload.recommendationEventId) return { ok: false };
  if (typeof payload.verdict !== "string" || !VERDICT_VALUES.has(payload.verdict)) return { ok: false };
  if (typeof payload.wouldAct !== "string" || !WOULD_ACT_VALUES.has(payload.wouldAct)) return { ok: false };
  if (!Array.isArray(payload.reasonCodes) || payload.reasonCodes.some((c) => typeof c !== "string" || !REASON_CODE_VALUES.has(c))) {
    return { ok: false };
  }
  if (payload.agentRunId !== undefined && payload.agentRunId !== null && typeof payload.agentRunId !== "string") return { ok: false };

  return {
    ok: true,
    value: {
      recommendationEventId: payload.recommendationEventId,
      agentRunId: typeof payload.agentRunId === "string" ? payload.agentRunId : null,
      verdict: payload.verdict as ReviewVerdict,
      wouldAct: payload.wouldAct as ReviewWouldAct,
      reasonCodes: payload.reasonCodes as ReviewReasonCode[],
    },
  };
}
