import { Eye, Lock, Clock } from "lucide-react";

type LadderStage = {
  step: number;
  title: string;
  description: string;
  badge: "current" | "locked" | "future";
};

const STAGES: LadderStage[] = [
  { step: 1, title: "Shadow", description: "Observe and recommend. No customer action.", badge: "current" },
  { step: 2, title: "Human Approval", description: "Propose a consequential action — a human decides.", badge: "locked" },
  { step: 3, title: "Limited Auto-Execute", description: "Low-risk, reversible actions run automatically.", badge: "future" },
  { step: 4, title: "Trusted Autonomy", description: "Earned, broad autonomy within policy.", badge: "future" },
];

const BADGE_STYLE: Record<LadderStage["badge"], string> = {
  current: "bg-gold-50 text-gold-700 ring-gold-200",
  locked: "bg-surface-sunken text-ink-500 ring-surface-border",
  future: "bg-surface-sunken text-ink-400 ring-surface-border",
};

const BADGE_LABEL: Record<LadderStage["badge"], string> = {
  current: "CURRENT",
  locked: "NOT AUTHORIZED",
  future: "FUTURE",
};

const BADGE_ICON: Record<LadderStage["badge"], typeof Eye> = {
  current: Eye,
  locked: Lock,
  future: Clock,
};

/**
 * P1 Sprint 3 §14 — a restrained, premium trust-progression ladder. Purely
 * presentational, no props, no state — this must never visually suggest a
 * future stage is enabled. Server Component: every value here is a plain
 * literal, nothing to keep RSC-safe in the first place.
 */
export function ApprovalModeLadder() {
  return (
    <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {STAGES.map((stage) => {
        const Icon = BADGE_ICON[stage.badge];
        return (
          <li
            key={stage.step}
            className={`rounded-card p-4 ring-1 ${stage.badge === "current" ? "bg-brand-950 text-white ring-brand-900" : "bg-white ring-surface-border"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={`text-xs font-semibold ${stage.badge === "current" ? "text-brand-300" : "text-ink-400"}`}>Step {stage.step}</span>
              <span className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[10px] font-bold tracking-wide ring-1 ${BADGE_STYLE[stage.badge]}`}>
                <Icon className="h-3 w-3" aria-hidden="true" />
                {BADGE_LABEL[stage.badge]}
              </span>
            </div>
            <p className={`mt-2 text-sm font-bold ${stage.badge === "current" ? "text-white" : "text-ink-900"}`}>{stage.title}</p>
            <p className={`mt-1 text-xs ${stage.badge === "current" ? "text-brand-200" : "text-ink-500"}`}>{stage.description}</p>
          </li>
        );
      })}
    </ol>
  );
}
