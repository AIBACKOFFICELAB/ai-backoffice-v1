import type { ReactNode } from "react";
import { Info, CircleCheck, TriangleAlert, CircleX } from "lucide-react";

type AlertTone = "info" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<AlertTone, string> = {
  info: "bg-brand-50 text-brand-900 ring-brand-100",
  success: "bg-success-50 text-success-700 ring-success-100",
  warning: "bg-warning-50 text-warning-700 ring-warning-100",
  danger: "bg-danger-50 text-danger-700 ring-danger-100",
};

const TONE_ICONS: Record<AlertTone, typeof Info> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleX,
};

/**
 * Status callout — not the sole indicator of state (icon + text always
 * accompany the color, per the P1B accessibility standard: "color is not
 * the sole status indicator").
 */
export function Alert({
  tone = "info",
  title,
  children,
  className = "",
}: {
  tone?: AlertTone;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const Icon = TONE_ICONS[tone];
  return (
    <div role={tone === "danger" || tone === "warning" ? "alert" : "status"} className={`flex gap-3 rounded-control p-4 text-sm ring-1 ${TONE_CLASSES[tone]} ${className}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? "mt-1" : undefined}>{children}</div>}
      </div>
    </div>
  );
}
