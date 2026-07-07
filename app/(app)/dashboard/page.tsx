export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { buildLeadMetrics, getLeads } from "@/lib/leads/repository";
import { getTenantContext } from "@/lib/tenant";
import { getMissedCallAnalytics } from "@/lib/modules/missedCallRecovery/service";
import { getEstimateFollowupAnalytics } from "@/lib/modules/estimateFollowup/service";
import { Card } from "@/components/ui/Card";

export default async function DashboardPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const { leads } = await getLeads(tenant.tenantId);
  const { totalLeads, newLeads, emergencyLeads, followUpsDue, estimatesSent, jobsWon, revenuePipeline, reviewPending } = buildLeadMetrics(leads);

  const [missedCallAnalytics, estimateFollowupAnalytics] = await Promise.all([
    getMissedCallAnalytics(tenant.tenantId),
    getEstimateFollowupAnalytics(tenant.tenantId),
  ]);

  const metrics: Array<{ label: string; value: string | number; href?: string }> = [
    { label: "Total Leads", value: totalLeads, href: "/lead-inbox" },
    { label: "New Leads", value: newLeads, href: "/lead-inbox" },
    { label: "Emergency Leads", value: emergencyLeads, href: "/lead-inbox" },
    { label: "Follow-Ups Due", value: followUpsDue, href: "/follow-ups" },
    { label: "Estimates Sent", value: estimatesSent },
    { label: "Jobs Won", value: jobsWon },
    { label: "Revenue Pipeline", value: `$${revenuePipeline.toLocaleString()}` },
    { label: "Review Requests Pending", value: reviewPending, href: "/review-requests" },
  ];

  return (
    <div className="space-y-8">
      <section className="rounded-card bg-brand-950 p-7 text-white shadow-raised">
        <h1 className="text-2xl font-bold sm:text-3xl">Revenue Command Center</h1>
        <p className="mt-2 text-brand-200">{tenant.tenantName} — powered by your lead inbox.</p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map((metric) => {
          const content = (
            <>
              <p className="text-sm font-semibold text-ink-500">{metric.label}</p>
              <p className="mt-2 text-3xl font-bold text-ink-900">{metric.value}</p>
            </>
          );
          return metric.href ? (
            <Link key={metric.label} href={metric.href} className="block">
              <Card className="p-5 transition hover:shadow-raised">{content}</Card>
            </Link>
          ) : (
            <Card key={metric.label} className="p-5">
              {content}
            </Card>
          );
        })}
      </section>

      <section>
        <h2 className="text-xl font-bold text-ink-900">Automation performance</h2>
        <p className="text-sm text-ink-500">Every module execution, measured.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Card className="p-5">
            <p className="text-sm font-semibold text-ink-500">Missed Call Recovery</p>
            <div className="mt-3 grid grid-cols-4 gap-3 text-center">
              <div>
                <p className="text-2xl font-bold text-ink-900">{missedCallAnalytics.totalMissedCalls}</p>
                <p className="text-xs text-ink-400">Missed calls</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-emerald-600">{missedCallAnalytics.recovered}</p>
                <p className="text-xs text-ink-400">Recovered</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-ink-900">{missedCallAnalytics.ownerNotified}</p>
                <p className="text-xs text-ink-400">Owner notified</p>
              </div>
              <div>
                <p className={`text-2xl font-bold ${missedCallAnalytics.ownerNotificationFailures > 0 ? "text-red-600" : "text-ink-900"}`}>
                  {missedCallAnalytics.ownerNotificationFailures}
                </p>
                <p className="text-xs text-ink-400">Notify failures</p>
              </div>
            </div>
          </Card>

          <Card className="p-5">
            <p className="text-sm font-semibold text-ink-500">Estimate Follow-up</p>
            <div className="mt-3 grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-2xl font-bold text-ink-900">{estimateFollowupAnalytics.active}</p>
                <p className="text-xs text-ink-400">Active</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-emerald-600">{estimateFollowupAnalytics.replied}</p>
                <p className="text-xs text-ink-400">Replied</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-ink-900">{estimateFollowupAnalytics.replyRate}%</p>
                <p className="text-xs text-ink-400">Reply rate</p>
              </div>
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
