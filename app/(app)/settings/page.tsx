export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getTenantContext, getTenantProfile } from "@/lib/tenant";
import { getMissedCallSettings } from "@/lib/modules/missedCallRecovery/service";
import MissedCallRecoverySettingsForm from "@/components/MissedCallRecoverySettingsForm";
import { BusinessProfileForm } from "@/components/BusinessProfileForm";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";

const integrations = ["Twilio", "Gmail", "Google Calendar", "Stripe", "Supabase"];

export default async function SettingsPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  // Settings, especially Business Profile, are owner-only. Staff members
  // never see the Settings nav item (components/AppShell.tsx), but that's a
  // UI convenience, not enforcement — a direct URL visit is blocked here too.
  if (tenant.role !== "owner") redirect("/dashboard");

  const [mcrSettings, profile] = await Promise.all([
    getMissedCallSettings(tenant.tenantId),
    getTenantProfile(tenant.tenantId),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description={`Manage ${tenant.tenantName}'s automation and business profile.`} />

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-ink-900">Missed Call Recovery</h2>
          <p className="mt-1 text-sm text-ink-500">
            Configure the automated SMS sent to callers and the owner notifications sent every time a call is recovered.
          </p>
        </CardHeader>
        <CardBody>
          {mcrSettings ? (
            <MissedCallRecoverySettingsForm
              initial={{
                enabled: mcrSettings.enabled,
                businessPhone: mcrSettings.businessPhone,
                ownerAlertPhone: mcrSettings.ownerAlertPhone,
                ownerNotificationEmail: mcrSettings.ownerNotificationEmail,
                intakeFormUrl: mcrSettings.intakeFormUrl,
                emergencyPhone: mcrSettings.emergencyPhone,
                businessTagline: mcrSettings.businessTagline,
                smsTemplate: mcrSettings.smsTemplate,
              }}
            />
          ) : (
            <p className="text-sm text-red-700">Missed Call Recovery is not yet configured for this tenant.</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-ink-900">Business Profile</h2>
          <p className="mt-1 text-sm text-ink-500">Shown on customer-facing messages and review requests.</p>
        </CardHeader>
        <CardBody>
          {profile ? (
            <BusinessProfileForm initial={profile} />
          ) : (
            <p className="text-sm text-red-700">Couldn&apos;t load your business profile. Try refreshing.</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold text-ink-900">Integrations</h2>
          <p className="mt-1 text-sm text-ink-500">Coming soon — these will be one-click connections.</p>
        </CardHeader>
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
            {integrations.map((name) => (
              <div
                key={name}
                className="flex items-center justify-between rounded-control border border-dashed border-surface-border p-4 text-sm text-ink-500"
              >
                {name}
                <span className="rounded-pill bg-surface-sunken px-2 py-0.5 text-xs font-semibold text-ink-400">Soon</span>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
