import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { getUser } from "@/lib/auth";
import { getBillingState, getTenantContextUnchecked } from "@/lib/tenant";
import Link from "next/link";

// This layout checks auth state via cookies on every request, so the
// authenticated app must be dynamic. The marketing route group is
// unaffected and can still be statically optimized.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let onboardingPending = false;

  const user = await getUser();
  const ctx = user ? await getTenantContextUnchecked() : null;
  if (ctx) {
    const billing = await getBillingState(ctx.tenantId);
    // Fail closed: unknown billing state or a non-entitled paid tenant -> restricted page.
    if (billing === "error" || (billing && billing.entitlement !== "active")) redirect("/billing/restricted");
    onboardingPending = !!billing && billing.onboardingStatus !== "complete";
  }

  return (
    <AppShell>
      {onboardingPending && (
        <div role="status" className="mb-6 rounded-control border border-gold-300 bg-gold-50 px-4 py-3 text-sm text-ink-900">
          <strong>PAID — ONBOARDING REQUIRED.</strong> Your Founder Beta is active. Your data sources are connected during Founder-assisted onboarding.{" "}
          <Link href="/onboarding" className="font-semibold text-brand-700 underline">See next steps</Link>
        </div>
      )}
      {children}
    </AppShell>
  );
}
