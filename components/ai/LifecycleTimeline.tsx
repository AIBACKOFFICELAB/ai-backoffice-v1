import { CheckCircle2, Circle } from "lucide-react";
import { formatOperationalTimestamp } from "@/lib/format/timestamp";
import type { TimelineStage } from "@/lib/agents/estimateClosing/evidenceTimeline";

/**
 * P1 Sprint 7 §8 — the premium, business-language lifecycle timeline: "the
 * user should be able to understand the entire story without reconstructing
 * it from multiple pages." Purely presentational — every stage's content
 * comes from evidenceTimeline.ts's pure read model; this component never
 * fetches, infers, or fabricates anything.
 *
 * Status is never conveyed by color alone (§23): a completed stage shows a
 * filled check icon AND its timestamp; a pending stage shows an outline
 * circle AND the word "Pending" as visible text.
 */
export function LifecycleTimeline({ stages }: { stages: TimelineStage[] }) {
  return (
    <ol className="space-y-0">
      {stages.map((stage, index) => {
        const formatted = formatOperationalTimestamp(stage.occurredAt);
        const isLast = index === stages.length - 1;
        return (
          <li key={stage.kind} className="relative flex gap-3 pb-5 last:pb-0">
            {!isLast && <span className="absolute left-[9px] top-6 h-[calc(100%-1.25rem)] w-px bg-surface-border" aria-hidden="true" />}
            <span className="mt-0.5 shrink-0" aria-hidden="true">
              {stage.status === "completed" ? (
                <CheckCircle2 className="h-[18px] w-[18px] text-success-600" />
              ) : (
                <Circle className="h-[18px] w-[18px] text-ink-300" />
              )}
            </span>
            <div className="min-w-0 flex-1 pt-px">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <p className={`text-sm font-semibold ${stage.status === "completed" ? "text-ink-900" : "text-ink-500"}`}>{stage.label}</p>
                <span className="text-xs font-medium text-ink-400" title={formatted?.title}>
                  {stage.status === "completed" ? (formatted?.display ?? "Recorded") : "Pending"}
                </span>
              </div>
              {stage.detail && <p className="mt-0.5 text-xs text-ink-500">{stage.detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
