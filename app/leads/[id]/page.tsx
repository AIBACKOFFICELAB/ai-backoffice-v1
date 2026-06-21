export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import Link from "next/link";
import { getLeadById } from "@/lib/leads/repository";
import LeadEditForm from "@/components/LeadEditForm";

function recommendedAction(status: string, emergency: string, reviewStatus: string) {
  if (emergency === "Yes" && status === "New") return "Call immediately and confirm dispatch window for emergency service.";
  if (status === "Estimate Sent") return "Follow up on the estimate and offer next available appointment slot.";
  if (reviewStatus === "Ready to Send") return "Send review request now while the customer experience is still fresh.";
  if (status === "Completed") return "Confirm payment closeout and request a Google review.";
  return "Send a status update and schedule the next follow-up touchpoint.";
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { lead, source } = await getLeadById(id);
  if (!lead) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link href="/lead-inbox" className="text-sm text-blue-600 hover:underline">
            ← Lead Inbox
          </Link>
          <h1 className="mt-1 text-3xl font-bold text-slate-900">
            {lead.emergency === "Yes" ? "🚨 " : ""}
            {lead.customerName}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {new Date(lead.date).toLocaleString()} &bull; {lead.phone}
            {lead.email ? ` • ${lead.email}` : ""} &bull;{" "}
            <span className="uppercase tracking-wide">
              {source === "supabase" ? "Supabase" : source === "google-sheets" ? "Google Sheet" : "Fallback"}
            </span>
          </p>
        </div>
      </div>

      {/* Editable fields */}
      <LeadEditForm lead={lead} />

      {/* Read-only details */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 space-y-1 text-sm text-slate-700">
          <h2 className="font-semibold text-slate-900 mb-2">Customer Contact</h2>
          <p>{lead.phone}</p>
          <p>{lead.email || "No email provided"}</p>
          <p>{lead.serviceAddress}</p>
          <p><span className="font-semibold">Role:</span> {lead.customerRole}</p>
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 space-y-1 text-sm text-slate-700">
          <h2 className="font-semibold text-slate-900 mb-2">Job & Sales Info</h2>
          <p><span className="font-semibold">Property Type:</span> {lead.propertyType}</p>
          <p><span className="font-semibold">Service Type:</span> {lead.serviceType}</p>
          <p><span className="font-semibold">Emergency:</span> {lead.emergency}</p>
          <p><span className="font-semibold">Urgency:</span> {lead.urgency}</p>
          <p><span className="font-semibold">Lead Source:</span> {lead.leadSource}</p>
          <p><span className="font-semibold">Preferred Appointment:</span> {lead.preferredAppointmentTime || "Not set"}</p>
          <p><span className="font-semibold">Photos Uploaded:</span> {lead.photosUploaded}</p>
          <p><span className="font-semibold">Review Request Status:</span> {lead.reviewRequestStatus}</p>
        </div>
      </div>

      <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="font-semibold text-slate-900 mb-2">Job Description</h2>
        <p className="text-sm text-slate-700">{lead.jobDescription}</p>
      </div>

      <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="font-semibold text-slate-900 mb-2">Customer Notes</h2>
        <p className="text-sm text-slate-700">{lead.customerNotes || "None"}</p>
      </div>

      <div className="rounded-xl border border-blue-100 bg-blue-50 p-5 shadow-sm">
        <h2 className="font-semibold text-slate-900">Recommended Next Action</h2>
        <p className="mt-2 text-sm text-slate-700">
          {recommendedAction(lead.status, lead.emergency, lead.reviewRequestStatus)}
        </p>
      </div>
    </div>
  );
}
