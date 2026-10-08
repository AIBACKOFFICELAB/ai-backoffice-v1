import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { getBillingState, getTenantContextUnchecked } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const metadata = { title: "Onboarding" };

const LABELS = {
  onboarding_required: "PAID — ONBOARDING REQUIRED",
  in_progress: "ONBOARDING IN PROGRESS",
  complete: "ONBOARDING COMPLETE",
} as const;

export default async function OnboardingPage() {
  const ctx = await getTenantContextUnchecked();
  if (!ctx) redirect("/auth/login?redirectTo=/onboarding");
  const billing = await getBillingState(ctx.tenantId);
  if (billing === "error") redirect("/billing/restricted");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold text-ink-900">Welcome to AI BackOffice Founder Beta</h1>
      <Card className="p-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Status</p>
        <p className="mt-1 text-lg font-bold text-brand-800">{billing ? LABELS[billing.onboardingStatus] : "Internal workspace"}</p>
        <p className="mt-3 text-sm text-ink-700">
          Your subscription is active. No approval step is required. Onboarding is a hands-on service: we connect your lead and estimate
          data so AI BackOffice can show Estimate Closing intelligence for {ctx.tenantName}.
        </p>
        <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-ink-700">
          <li>Reply to your welcome email (or contact us) to schedule your onboarding session.</li>
          <li>We configure your business profile and connect your lead/estimate source.</li>
          <li>Your workspace shows owner-review recommendations and evidence for open estimates.</li>
        </ol>
        <p className="mt-4 text-sm text-ink-500">
          Founder Beta runs in Shadow mode: AI BackOffice recommends, you decide. It does not send messages to your customers on its own.
        </p>
      </Card>
    </div>
  );
}
