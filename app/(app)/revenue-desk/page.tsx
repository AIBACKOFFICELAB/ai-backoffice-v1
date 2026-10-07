export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { getRevenueDeskOverview, ownerFollowUp } from "@/lib/revenueDesk/readModel";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Alert } from "@/components/ui/Alert";
import { MetricCard } from "@/components/dashboard/MetricCard";
import { formatOperationalTimestamp } from "@/lib/format/timestamp";

const OUTCOME_LABEL: Record<string, string> = { confirmed: "Booked", conflict: "Slot taken", failed: "Booking failed", unavailable: "No availability", not_attempted: "Not attempted" };
const PRIORITY_LABEL: Record<string, string> = { routine: "Routine", priority: "Priority", urgent: "Urgent", human_escalation_required: "Needs a human" };

export default async function RevenueDeskPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");
  const data = await getRevenueDeskOverview(tenant.tenantId);

  return (
    <div className="space-y-6">
      <PageHeader title="Revenue Desk" description="Inbound calls answered for your business: intake, priority, bookings and hand-offs. Last 30 days." />
      {data.error ? (
        <Alert tone="danger">Revenue Desk activity is temporarily unavailable.</Alert>
      ) : (
        <>
          <Card>
            <CardBody className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink-700">
              <span>Status: <strong>{data.status === "enabled" ? "Answering calls" : data.status === "disabled" ? "Configured, not answering" : "Not set up yet"}</strong></span>
              <span>Booking: <strong>{data.bookingReady ? "Calendar connected" : "Not available"}</strong></span>
              <span>Live transfer: <strong>{data.transferReady ? "Configured" : "Not configured"}</strong></span>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="text-sm text-ink-700">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>Included minutes this month: <strong>{data.allowance.usedMinutes} of {data.allowance.includedMinutes}</strong> ({data.allowance.percentUsed}%)</span>
                {data.allowance.state !== "within" && (
                  <span className="font-semibold text-gold-700">{data.allowance.state === "exceeded" ? "Above the included allowance — calls are still answered; we will contact you." : "Approaching the included allowance."}</span>
                )}
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-valuenow={Math.min(100, data.allowance.percentUsed)} aria-valuemin={0} aria-valuemax={100} aria-label="Included minutes used">
                <div className="h-full bg-brand-700" style={{ width: `${Math.min(100, data.allowance.percentUsed)}%` }} />
              </div>
            </CardBody>
          </Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <MetricCard label="Inbound calls" value={data.summary.calls} />
            <MetricCard label="Booked" value={data.summary.booked} />
            <MetricCard label="Escalated" value={data.summary.escalated} />
            <MetricCard label="Failed" value={data.summary.failed} />
            <MetricCard label="Minutes / cost" value={`${data.summary.minutes} min${data.summary.costUsd != null ? ` · $${data.summary.costUsd.toFixed(2)}` : ""}`} helpText={data.summary.costPerMinute != null ? `$${data.summary.costPerMinute}/min reported by the voice provider` : "Cost appears once the provider reports it"} />
          </div>
          {data.recent.length === 0 ? (
            <EmptyState title="No calls yet" description="Calls answered by your Revenue Desk will appear here with their full evidence." />
          ) : (
            <Card>
              <ul className="divide-y divide-surface-border">
                {data.recent.map((c) => (
                  <li key={c.id}>
                    <Link href={`/revenue-desk/${c.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm hover:bg-surface-sunken">
                      <span className="font-medium text-ink-900">{formatOperationalTimestamp(c.created_at)?.display}</span>
                      <span className="text-ink-700">{c.intake?.customerName ?? "Caller"} · {c.service_category ?? "Service not captured"}</span>
                      <span className="text-ink-500">{c.priority ? PRIORITY_LABEL[c.priority] : "Unclassified"}</span>
                      {ownerFollowUp(c) ? (
                        <span className="font-semibold text-gold-700">{ownerFollowUp(c)!.label}</span>
                      ) : (
                        <span className="font-semibold text-ink-900">{c.booking_outcome ? OUTCOME_LABEL[c.booking_outcome] : c.status === "escalated" ? "Escalated" : c.status === "failed" ? "Failed" : c.status.replace("_", " ")}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
