export const dynamic = 'force-dynamic';

import { redirect } from "next/navigation";
import { buildLeadMetrics, getLeads } from "@/lib/leads/repository";
import { getTenantContext } from "@/lib/tenant";
import { getMissedCallAnalytics } from "@/lib/modules/missedCallRecovery/service";
import { getEstimateFollowupAnalytics } from "@/lib/modules/estimateFollowup/service";

export default async function DashboardPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const { leads, source } = await getLeads(tenant.tenantId);
  const { totalLeads, newLeads, emergencyLeads, followUpsDue, estimatesSent, jobsWon, revenuePipeline, reviewPending } = buildLeadMetrics(leads);

  const [missedCallAnalytics, estimateFollowupAnalytics] = await Promise.all([
    getMissedCallAnalytics(tenant.tenantId),
    getEstimateFollowupAnalytics(tenant.tenantId),
  ]);

  const metrics = [
    ["Total Leads", totalLeads],
    ["New Leads", newLeads],
    ["Emergency Leads", emergencyLeads],
    ["Follow-Ups Due", followUpsDue],
    ["Estimates Sent", estimatesSent],
    ["Jobs Won", jobsWon],
    ["Revenue Pipeline", `$${revenuePipeline.toLocaleString()}`],
    ["Review Requests Pending", reviewPending],
  ];

  return (
    <div className="space-y-8">
      <section className="rounded-2xl bg-slate-900 p-6 text-white shadow-lg ring-1 ring-slate-800">
        <h1 className="text-3xl font-bold">Revenue Command Center</h1>
        <p className="mt-2 text-slate-300">{tenant.tenantName} dashboard powered by lead inbox data.</p>
        <p className="mt-1 text-xs uppercase tracking-wide text-slate-400">Data source: {source === "google-sheets" ? "Live Google Sheet" : "Mock Fallback"}</p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div key={String(label)} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold text-slate-500">{label}</p>
            <p className="mt-2 text-3xl font-bold text-slate-900">{value}</p>
          </div>
        ))}
      </section>

      <section>
        <h2 className="text-xl font-bold text-slate-900">Automation Performance</h2>
        <p className="text-sm text-slate-600">Every module execution, measured — see docs/constitution/03_MODULE_ARCHITECTURE.md.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold text-slate-500">Missed Call Recovery</p>
            <div className="mt-3 grid grid-cols-4 gap-3 text-center">
              <div>
                <p className="text-2xl font-bold text-slate-900">{missedCallAnalytics.totalMissedCalls}</p>
                <p className="text-xs text-slate-500">Missed Calls</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-emerald-600">{missedCallAnalytics.recovered}</p>
                <p className="text-xs text-slate-500">Recovered</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-900">{missedCallAnalytics.ownerNotified}</p>
                <p className="text-xs text-slate-500">Owner Notified</p>
              </div>
              <div>
                <p className={`text-2xl font-bold ${missedCallAnalytics.ownerNotificationFailures > 0 ? "text-red-600" : "text-slate-900"}`}>
                  {missedCallAnalytics.ownerNotificationFailures}
                </p>
                <p className="text-xs text-slate-500">Notify Failures</p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold text-slate-500">Estimate Follow-up</p>
            <div className="mt-3 grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-2xl font-bold text-slate-900">{estimateFollowupAnalytics.active}</p>
                <p className="text-xs text-slate-500">Active</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-emerald-600">{estimateFollowupAnalytics.replied}</p>
                <p className="text-xs text-slate-500">Replied</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-slate-900">{estimateFollowupAnalytics.replyRate}%</p>
                <p className="text-xs text-slate-500">Reply Rate</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
