export const dynamic = 'force-dynamic';

import Link from "next/link";
import { getLeads } from "@/lib/leads/repository";

export default async function LeadInboxPage() {
  const { leads, source } = await getLeads();

  const sortedLeads = [...leads].sort((a, b) => {
    if (a.emergency === "Yes" && b.emergency !== "Yes") return -1;
    if (a.emergency !== "Yes" && b.emergency === "Yes") return 1;
    if (["Completed", "Lost"].includes(a.status) && !["Completed", "Lost"].includes(b.status)) return 1;
    if (!["Completed", "Lost"].includes(a.status) && ["Completed", "Lost"].includes(b.status)) return -1;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Lead Inbox</h1>
        <p className="text-slate-600">5 Star Plumbing Service Request Form → Google Sheet → AI BackOffice Lead Inbox.</p>
        <p className="mt-1 text-xs uppercase tracking-wide text-slate-500">Data source: {source === "google-sheets" ? "Live Google Sheet" : "Mock Fallback"}</p>
      </div>
      <div className="grid gap-4">
        {sortedLeads.map((lead) => {
          const isEmergency = lead.emergency === "Yes";
          const isNew = lead.status === "New";
          const isLowPriority = ["Completed", "Lost"].includes(lead.status);
          return (
            <Link key={lead.id} href={`/leads/${lead.id}`} className={`rounded-2xl bg-white p-4 text-left shadow-sm ring-1 transition hover:shadow-md ${isEmergency ? "border-2 border-red-500 ring-red-200" : "ring-slate-200"} ${isLowPriority ? "opacity-55" : "opacity-100"}`}>
              <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-lg font-semibold text-slate-900">{isEmergency ? "🚨 " : ""}{lead.customerName}</p><p className="text-sm text-slate-600">{new Date(lead.date).toLocaleString()} • {lead.phone} • {lead.email || "No email provided"}</p></div><div className="flex flex-wrap gap-2">{isNew && <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">New Lead</span>}<span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{lead.status}</span><span className={`rounded-full px-2 py-1 text-xs font-semibold ${isEmergency ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>{lead.urgency}</span></div></div>
              <div className="mt-3 grid gap-2 text-sm text-slate-700 md:grid-cols-2 xl:grid-cols-4"><p><span className="font-semibold">Address:</span> {lead.serviceAddress}</p><p><span className="font-semibold">Property:</span> {lead.propertyType}</p><p><span className="font-semibold">Service:</span> {lead.serviceType}</p><p><span className="font-semibold">Emergency:</span> {lead.emergency}</p><p><span className="font-semibold">Lead Source:</span> {lead.leadSource}</p><p><span className="font-semibold">Customer Role:</span> {lead.customerRole}</p><p><span className="font-semibold">Estimate:</span> ${lead.estimateAmount.toLocaleString()}</p><p><span className="font-semibold">Follow-Up:</span> {lead.followUpDate || "Not set"}</p><p><span className="font-semibold">Review Request:</span> {lead.reviewRequestStatus}</p></div>
              <p className="mt-2 text-sm text-slate-600"><span className="font-semibold text-slate-900">Job:</span> {lead.jobDescription}</p>
              <p className="mt-1 text-sm text-slate-600"><span className="font-semibold text-slate-900">Notes:</span> {lead.customerNotes}</p>
              <p className="mt-1 text-sm text-slate-600"><span className="font-semibold text-slate-900">Internal:</span> {lead.internalNotes}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
