import type { ReactNode } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";

export type ActionCardTone = "danger" | "warning" | "info";

const TONE_DOT: Record<ActionCardTone, string> = {
  danger: "bg-danger-600",
  warning: "bg-warning-600",
  info: "bg-brand-600",
};

/**
 * One "needs my attention" item on the Revenue Command Center — always
 * what/why/value(if legitimate)/safe-CTA, per P1 directive §16.C. `value`
 * is only ever a real, already-known dollar figure (an estimate amount,
 * for instance) — never invented for display purposes.
 */
export function ActionCard({
  tone = "info",
  title,
  description,
  value,
  href,
  cta = "Review",
  meta,
}: {
  tone?: ActionCardTone;
  title: string;
  description: string;
  value?: string;
  href: string;
  cta?: string;
  meta?: ReactNode;
}) {
  return (
    <Link href={href} className="block focus-ring rounded-card">
      <Card className="flex items-start gap-3 p-4 transition hover:shadow-raised">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="truncate font-semibold text-ink-900">{title}</p>
            {value && <span className="shrink-0 text-sm font-bold text-ink-900">{value}</span>}
          </div>
          <p className="mt-0.5 text-sm text-ink-500">{description}</p>
          {meta && <div className="mt-2">{meta}</div>}
        </div>
        <span className="mt-1 shrink-0 text-sm font-semibold text-brand-700">{cta} →</span>
      </Card>
    </Link>
  );
}
