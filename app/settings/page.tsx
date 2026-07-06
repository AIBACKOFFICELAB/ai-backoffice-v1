export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { getMissedCallSettings } from "@/lib/modules/missedCallRecovery/service";
import MissedCallRecoverySettingsForm from "@/components/MissedCallRecoverySettingsForm";

const integrations = ["Twilio", "Gmail", "Google Calendar", "Stripe", "Supabase"];

export default async function SettingsPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const mcrSettings = await getMissedCallSettings(tenant.tenantId);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Settings</h1>

      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-xl font-semibold">Missed Call Recovery</h2>
        <p className="mt-1 text-sm text-slate-600">
          Configure the automated SMS sent to callers and the owner notifications sent every time a call is recovered.
        </p>
        <div className="mt-4">
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
        </div>
      </div>

      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-xl font-semibold">Business Profile</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {['Business Name','Trade Type','Phone','Email'].map((field) => (
            <label key={field} className="text-sm font-medium text-slate-700">{field}
              <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" placeholder={`Enter ${field.toLowerCase()}`} />
            </label>
          ))}
        </div>
      </div>
      <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-xl font-semibold">Integrations (Coming Soon)</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-3">
          {integrations.map((name) => <div key={name} className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">{name} placeholder</div>)}
        </div>
      </div>
    </div>
  );
}
