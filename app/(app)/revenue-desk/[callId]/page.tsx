export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { getRevenueDeskCall, ownerFollowUp } from "@/lib/revenueDesk/readModel";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardBody } from "@/components/ui/Card";
import { formatOperationalTimestamp } from "@/lib/format/timestamp";
import { Alert } from "@/components/ui/Alert";

const ts = (v: string | null | undefined) => formatOperationalTimestamp(v)?.display ?? "—";

export default async function RevenueDeskCallPage({ params }: { params: Promise<{ callId: string }> }) {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");
  const { callId } = await params;
  const data = await getRevenueDeskCall(tenant.tenantId, callId);
  if (!data) notFound();
  const { call, bookings, events } = data;
  const intake = (call.intake ?? {}) as Record<string, any>;
  const followUp = ownerFollowUp(call);

  const rows: Array<[string, string]> = [
    ["Started", ts(call.started_at ?? call.created_at)],
    ["Ended", ts(call.ended_at)],
    ["Duration", call.duration_seconds != null ? `${Math.round(call.duration_seconds / 6) / 10} min` : "—"],
    ["Provider cost", call.provider_cost_usd != null ? `$${Number(call.provider_cost_usd).toFixed(4)}` : "Not reported"],
    ["Status", call.status],
    ["Priority", call.priority ?? "Unclassified"],
    ["Urgency signals", (call.urgency_signals ?? []).join(", ") || "None"],
    ["Policy reasons", (intake.reasons ?? []).join(", ") || "—"],
    ["Escalation", call.escalation_reason ? `${call.escalation_reason} → ${call.escalation_result ?? "requested"}` : "None"],
    ["Booking outcome", call.booking_outcome ?? "Not attempted"],
    ["Failure", call.failure_category ?? "None"],
    ["Ended reason", call.ended_reason ?? "—"],
  ];

  return (
    <div className="space-y-6">
      <Link href="/revenue-desk" className="text-sm font-semibold text-brand-700">← Revenue Desk</Link>
      <PageHeader title={`Call · ${ts(call.created_at)}`} description="Structured operational evidence. Audio and full transcripts are not stored." />
      {followUp && <Alert tone="warning"><strong>Action needed: {followUp.label}.</strong> {followUp.detail}</Alert>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card><CardBody>
          <h2 className="text-sm font-semibold text-ink-900">Service request</h2>
          <dl className="mt-3 space-y-1.5 text-sm text-ink-700">
            <div><dt className="inline font-medium">Caller: </dt><dd className="inline">{intake.customerName ?? "Not captured"}</dd></div>
            <div><dt className="inline font-medium">Service: </dt><dd className="inline">{call.service_category ?? "Not captured"}</dd></div>
            <div><dt className="inline font-medium">Request: </dt><dd className="inline">{intake.jobDescription ?? "—"}</dd></div>
            <div><dt className="inline font-medium">Preferred timing: </dt><dd className="inline">{intake.preferredTiming ?? "—"}</dd></div>
            <div><dt className="inline font-medium">Lead: </dt><dd className="inline">{call.lead_id ? <Link className="text-brand-700 underline" href={`/leads/${call.lead_id}`}>Open lead</Link> : "Not created"}</dd></div>
          </dl>
        </CardBody></Card>
        <Card><CardBody>
          <h2 className="text-sm font-semibold text-ink-900">Outcome</h2>
          <dl className="mt-3 space-y-1.5 text-sm text-ink-700">
            {rows.map(([k, v]) => <div key={k}><dt className="inline font-medium">{k}: </dt><dd className="inline">{v}</dd></div>)}
          </dl>
        </CardBody></Card>
      </div>
      <Card><CardBody>
        <h2 className="text-sm font-semibold text-ink-900">Booking attempts</h2>
        {bookings.length === 0 ? <p className="mt-2 text-sm text-ink-500">No booking was attempted.</p> : (
          <ul className="mt-2 space-y-1.5 text-sm text-ink-700">
            {bookings.map((b: any) => (
              <li key={b.id}>{ts(b.requested_start)} ({b.timezone}) — <strong>{b.status}</strong>{b.provider_event_id ? " · calendar event confirmed" : ""}{b.failure_category ? ` · ${b.failure_category}` : ""}</li>
            ))}
          </ul>
        )}
      </CardBody></Card>
      <Card><CardBody>
        <h2 className="text-sm font-semibold text-ink-900">Lifecycle timeline</h2>
        <ol className="mt-2 space-y-1.5 text-sm text-ink-700">
          {events.map((e: any) => <li key={e.id}><span className="font-mono text-xs text-ink-500">{ts(e.occurred_at)}</span> · {e.event_type.replace("revenue_desk.", "")}</li>)}
          {events.length === 0 && <li className="text-ink-500">No recorded events.</li>}
        </ol>
      </CardBody></Card>
    </div>
  );
}
