import type { ReactNode } from "react";

/**
 * One row in the "AI Workforce / Activity" feed. Deliberately takes
 * pre-formatted, already-truthful props rather than a raw business_event —
 * callers (dashboard/page.tsx) are responsible for only ever passing REAL
 * recorded activity (P1 directive §21 "No Fake Data"); this component has
 * no fallback/mock content of its own.
 */
export function ActivityItem({
  icon,
  title,
  description,
  timestamp,
  badge,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  timestamp: string;
  badge?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-surface-sunken text-ink-500">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-ink-900">{title}</p>
          {badge}
        </div>
        <p className="mt-0.5 text-sm text-ink-500">{description}</p>
      </div>
      <span className="shrink-0 whitespace-nowrap text-xs text-ink-400">{timestamp}</span>
    </li>
  );
}
