import { Button } from "@/components/ui/Button";
import { founderBetaEnrollmentGate } from "@/lib/billing/enrollment";

export const ENROLLMENT_UNAVAILABLE_MESSAGE = "Online enrollment for Founder Beta is temporarily unavailable. No payment can be taken right now.";

/** Plain form POST -> /api/billing/checkout -> 303 to Stripe Checkout. No client JS needed.
 * While the server-side enrollment gate is closed (the default) no purchase
 * form is rendered at all — only a truthful unavailability notice. */
export function FounderBetaCheckoutButton({ label = "Start Founder Beta — $299/month", variant, className }: { label?: string; variant?: "primary" | "secondary"; className?: string }) {
  if (!founderBetaEnrollmentGate().open) {
    const tone = variant === "secondary" ? "bg-white/10 text-white ring-white/25" : "bg-surface-sunken text-ink-700 ring-surface-border";
    return (
      <p role="status" className={`rounded-control px-4 py-3 text-sm font-medium ring-1 ${tone} ${className ?? ""}`}>
        {ENROLLMENT_UNAVAILABLE_MESSAGE}
      </p>
    );
  }
  return (
    <form method="post" action="/api/billing/checkout">
      <Button type="submit" size="lg" variant={variant} className={className}>{label}</Button>
    </form>
  );
}
