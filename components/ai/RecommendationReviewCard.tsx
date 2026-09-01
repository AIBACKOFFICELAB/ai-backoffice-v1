import { Card } from "@/components/ui/Card";
import { ShadowRecommendationCard } from "@/components/ai/ShadowRecommendationCard";
import { ReviewControls } from "@/components/ai/ReviewControls";
import { VERDICT_LABELS, WOULD_ACT_LABELS, REVIEW_REASON_CODE_LABELS } from "@/lib/agents/estimateClosing/reviewTypes";
import type { EstimateClosingRecommendationReviewView } from "@/lib/agents/estimateClosing/evaluationReadModel";
import type { EstimateClosingRecommendation } from "@/lib/agents/estimateClosing/types";

/**
 * P1 Sprint 3 — pairs the existing, read-only ShadowRecommendationCard with
 * either the owner's already-recorded review (a plain, server-rendered
 * summary) or the interactive ReviewControls client island. A Server
 * Component rendering a Client Component as a CHILD is the safe RSC
 * direction (the reverse — a Client Component importing a Server
 * Component — is not); every prop passed down here is plain, JSON-
 * serializable data (see navConfig.test.ts's regression-class precedent).
 */
export function RecommendationReviewCard({
  recommendationEventId,
  recommendation,
  serviceType,
  occurredAt,
  existingReview,
}: {
  recommendationEventId: string;
  recommendation: EstimateClosingRecommendation;
  serviceType: string;
  occurredAt: string;
  existingReview: EstimateClosingRecommendationReviewView | null;
}) {
  return (
    <div className="space-y-2">
      <ShadowRecommendationCard recommendation={recommendation} serviceType={serviceType} occurredAt={occurredAt} />
      <Card className="p-4">
        {existingReview ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Your review</p>
            <p className="mt-1 text-sm font-semibold text-ink-900">
              {VERDICT_LABELS[existingReview.verdict]} · {WOULD_ACT_LABELS[existingReview.wouldAct]}
            </p>
            {existingReview.reasonCodes.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {existingReview.reasonCodes.map((code) => (
                  <li key={code} className="rounded-pill bg-surface-sunken px-2.5 py-1 text-xs font-medium text-ink-700">
                    {REVIEW_REASON_CODE_LABELS[code]}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-ink-400">Reviewed {existingReview.occurredAt}</p>
          </div>
        ) : (
          <ReviewControls recommendationEventId={recommendationEventId} />
        )}
      </Card>
    </div>
  );
}
