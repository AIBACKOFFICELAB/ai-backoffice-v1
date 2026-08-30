import { Card } from "@/components/ui/Card";
import { AIStatusBadge } from "@/components/ui/AIStatusBadge";
import { labelReasonCode, labelRecommendation, labelChannel, labelTiming } from "@/lib/agents/estimateClosing/labels";
import type { EstimateClosingRecommendation } from "@/lib/agents/estimateClosing/types";

/**
 * P1B "Shadow Mode UX" — renders exactly the fields the P1 directive
 * specifies (§17): agent, opportunity, estimate value, recommendation,
 * confidence, reason, suggested next step, mode, "customer contacted: no".
 * Never implies an action occurred — there is no button here that could.
 */
export function ShadowRecommendationCard({
  recommendation,
  serviceType,
  occurredAt,
}: {
  recommendation: EstimateClosingRecommendation;
  serviceType: string;
  occurredAt: string;
}) {
  const timingLabel = labelTiming(recommendation.suggestedTiming);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink-500">Estimate Closing Agent</p>
        <AIStatusBadge mode="shadow" />
      </div>

      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-lg font-bold text-ink-900">{serviceType} opportunity</h3>
        {recommendation.opportunityValue != null && (
          <p className="text-2xl font-bold text-ink-900">${recommendation.opportunityValue.toLocaleString()}</p>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Recommendation</p>
          <p className="mt-1 font-semibold text-ink-900">{labelRecommendation(recommendation.recommendation)}</p>
        </div>
        {recommendation.confidence != null && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Confidence</p>
            <p className="mt-1 font-semibold text-ink-900">{Math.round(recommendation.confidence * 100)}%</p>
          </div>
        )}
      </div>

      {recommendation.reasonCodes.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Why</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {recommendation.reasonCodes.map((code) => (
              <li key={code} className="rounded-pill bg-surface-sunken px-2.5 py-1 text-xs font-medium text-ink-700">
                {labelReasonCode(code)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(recommendation.suggestedChannel !== "none" || timingLabel) && (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Suggested next step</p>
          <p className="mt-1 text-sm text-ink-700">
            {labelChannel(recommendation.suggestedChannel)}
            {timingLabel ? ` — ${timingLabel}` : ""}
          </p>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-surface-border pt-4 text-xs text-ink-400">
        <span>Detected {occurredAt}</span>
        <span className="font-semibold text-ink-500">Customer contacted: No</span>
      </div>
    </Card>
  );
}
