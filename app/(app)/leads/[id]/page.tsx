export const dynamic = "force-dynamic";

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getLeadById } from "@/lib/leads/repository";
import { getTenantContext } from "@/lib/tenant";
import { getMissedCallHistoryForLead } from "@/lib/modules/missedCallRecovery/service";
import { getEstimateFollowupSettings } from "@/lib/modules/estimateFollowup/service";
import LeadEditForm from "@/components/LeadEditForm";
import { Card } from "@/components/ui/Card";

const MCR_STYLES: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-700",
  recovered: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  skipped: "bg-amber-100 text-amber-700",
  pending: "bg-slate-100 text-slate-700",
};

function McrStatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded-pill px-2.5 py-1 text-xs font-semibold ${MCR_STYLES[status] ?? "bg-slate-100 text-slate-700"}`}>
      {status}
    </span>
  );
}

function recommendedAction(status: string, emergency: string, reviewStatus: string) {
  if (emergency === "Yes" && status === "New") return "Call immediately and confirm dispatch window for emergency service.";
  if (status === "Estimate Sent") return "Follow up on the estimate and offer next available appointment slot.";
  if (reviewStatus === "Ready to Send") return "Send review request now while the customer experience is still fresh.";
  if (status === "Completed") return "Confirm payment closeout and request a Google review.";
  return "Send a status update and schedule the next follow-up touchpoint.";
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const { id } = await params;
  const { lead } = await getLeadById(id, tenant.tenantId);
  if (!lead) notFound();

  const [mcrHistory, followupSettings] = await Promise.all([
    getMissedCallHistoryForLead(tenant.tenantId, id),
    getEstimateFollowupSettings(tenant.tenantId),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/lead-inbox" className="text-sm font-medium text-brand-700 hover:underline">
          ← Lead Inbox
        </Link>
        <h1 className="mt-1 text-3xl font-bold text-ink-900">
          {lead.emergency === "Yes" ? "🚨 " : ""}
          {lead.customerName}
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          {new Date(lead.date).toLocaleString()} &bull; {lead.phone}
          {lead.email ? ` • ${lead.email}` : ""}
        </p>
      </div>

      <LeadEditForm lead={lead} followupEnabled={followupSettings?.enabled ?? false} />

      {mcrHistory && (
        <Card className="p-5">
          <h2 className="mb-3 font-semibold text-ink-900">Missed Call Recovery</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Recovery SMS (intake form sent)</p>
              <div className="mt-1"><McrStatusBadge status={mcrHistory.recovery_sms_status ?? "pending"} /></div>
              {mcrHistory.recovery_sms_failure_reason && (
                <p className="mt-1 text-xs text-red-600">{mcrHistory.recovery_sms_failure_reason}</p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Owner SMS notification</p>
              <div className="mt-1"><McrStatusBadge status={mcrHistory.owner_sms_status ?? "pending"} /></div>
              {mcrHistory.owner_sms_failure_reason && (
                <p className="mt-1 text-xs text-red-600">{mcrHistory.owner_sms_failure_reason}</p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Owner email notification</p>
              <div className="mt-1"><McrStatusBadge status={mcrHistory.owner_email_status ?? "pending"} /></div>
              {mcrHistory.owner_email_failure_reason && (
                <p className="mt-1 text-xs text-red-600">{mcrHistory.owner_email_failure_reason}</p>
              )}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Emergency instructions sent</p>
              <div className="mt-1"><McrStatusBadge status={mcrHistory.recovery_sms_status === "sent" ? "sent" : "pending"} /></div>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-1 p-5 text-sm text-ink-700">
          <h2 className="mb-2 font-semibold text-ink-900">Customer contact</h2>
          <p>{lead.phone}</p>
          <p>{lead.email || "No email provided"}</p>
          <p>{lead.serviceAddress}</p>
          <p><span className="font-semibold">Role:</span> {lead.customerRole}</p>
        </Card>

        <Card className="space-y-1 p-5 text-sm text-ink-700">
          <h2 className="mb-2 font-semibold text-ink-900">Job &amp; sales info</h2>
          <p><span className="font-semibold">Property type:</span> {lead.propertyType}</p>
          <p><span className="font-semibold">Service type:</span> {lead.serviceType}</p>
          <p><span className="font-semibold">Emergency:</span> {lead.emergency}</p>
          <p><span className="font-semibold">Urgency:</span> {lead.urgency}</p>
          <p><span className="font-semibold">Lead source:</span> {lead.leadSource}</p>
          <p><span className="font-semibold">Preferred appointment:</span> {lead.preferredAppointmentTime || "Not set"}</p>
          <p><span className="font-semibold">Photos uploaded:</span> {lead.photosUploaded}</p>
          <p><span className="font-semibold">Review request status:</span> {lead.reviewRequestStatus}</p>
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="mb-2 font-semibold text-ink-900">Job description</h2>
        <p className="text-sm text-ink-700">{lead.jobDescription}</p>
      </Card>

      <Card className="p-5">
        <h2 className="mb-2 font-semibold text-ink-900">Customer notes</h2>
        <p className="text-sm text-ink-700">{lead.customerNotes || "None"}</p>
      </Card>

      <Card tone="highlight" className="border-l-4 border-l-brand-600 p-5">
        <h2 className="font-semibold text-ink-900">Recommended next action</h2>
        <p className="mt-2 text-sm text-ink-700">
          {recommendedAction(lead.status, lead.emergency, lead.reviewRequestStatus)}
        </p>
      </Card>
    </div>
  );
}
