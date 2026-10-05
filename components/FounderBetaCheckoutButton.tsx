import { Button } from "@/components/ui/Button";

/** Plain form POST -> /api/billing/checkout -> 303 to Stripe Checkout. No client JS needed. */
export function FounderBetaCheckoutButton({ label = "Start Founder Beta — $299/month", variant, className }: { label?: string; variant?: "primary" | "secondary"; className?: string }) {
  return (
    <form method="post" action="/api/billing/checkout">
      <Button type="submit" size="lg" variant={variant} className={className}>{label}</Button>
    </form>
  );
}
