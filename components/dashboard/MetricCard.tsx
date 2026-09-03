import type { ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";

/**
 * Revenue Command Center metric tile — explains meaning, not just a giant
 * number (P1B "Visual Direction": "Metrics must explain meaning, not just
 * show giant numbers"). No trend/sparkline here: this codebase has no
 * historical time-series to compute a truthful trend from yet (see P1
 * directive §21 "No Fake Data") — a fabricated up/down arrow is worse than
 * none.
 */
export function MetricCard({
  label,
  value,
  valueTitle,
  truncateValue = false,
  helpText,
  href,
  icon,
  tone = "default",
}: {
  label: string;
  value: string | number;
  /** Optional accessible tooltip (native `title` attribute) on the value —
   * for a value rendered as concise display text, e.g. the exact raw
   * timestamp behind a "Sep 3, 2026 · 11:11 AM UTC" display value. Never
   * required; a bare number/string value simply has no tooltip. */
  valueTitle?: string;
  /**
   * Opt-in single-line ellipsis truncation on the value (P1 Sprint 6 visual
   * acceptance hotfix, Codex P2 finding on PR #26). Defaults to `false` —
   * MOST metric values are short numbers/business text ("Not enough
   * evidence yet", "3 / 1 / 2") that must stay fully readable, never
   * silently clipped just because they happen to render inside a
   * MetricCard. Set `true` only for a value formatted specifically for a
   * compact card that could otherwise overflow at a narrow breakpoint (a
   * formatted timestamp being the first case — see
   * lib/format/timestamp.ts) — pair it with `valueTitle` so the full value
   * stays accessible via tooltip when truncated.
   */
  truncateValue?: boolean;
  helpText?: string;
  href?: string;
  icon?: ReactNode;
  tone?: "default" | "warning" | "success";
}) {
  const valueClass = tone === "warning" ? "text-warning-600" : tone === "success" ? "text-success-600" : "text-ink-900";

  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink-500">{label}</p>
        {icon && <span className="text-ink-400">{icon}</span>}
      </div>
      <p className={`mt-2 text-[28px] font-bold leading-none ${truncateValue ? "truncate" : ""} ${valueClass}`} title={valueTitle}>
        {value}
      </p>
      {helpText && <p className="mt-2 text-xs text-ink-400">{helpText}</p>}
    </>
  );

  if (href) {
    return (
      <Link href={href} className="block focus-ring rounded-card">
        <Card className="p-5 transition hover:shadow-raised">{content}</Card>
      </Link>
    );
  }

  return <Card className="p-5">{content}</Card>;
}
