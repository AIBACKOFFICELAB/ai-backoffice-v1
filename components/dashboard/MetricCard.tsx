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
  helpText,
  href,
  icon,
  tone = "default",
}: {
  label: string;
  value: string | number;
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
      <p className={`mt-2 text-[28px] font-bold leading-none ${valueClass}`}>{value}</p>
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
