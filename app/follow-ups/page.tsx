import Link from "next/link";
import { plumbingLeads } from "@/data/plumbingLeads";

export default function FollowUpsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const followUps = plumbingLeads
    .filter((lead) => lead.followUpDate && lead.followUpDate <= today && !["Completed", "Lost"].includes(lead.status))
    .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Follow-Ups Due</h1>
      <p className="text-slate-600">Leads that need a callback, estimate reminder, or scheduling confirmation.</p>
      <div className="grid gap-4">
        {followUps.map((lead) => (
          <Link key={lead.id} href={`/leads/${lead.id}`} className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-slate-900">{lead.customerName}</h2>
              <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-700">Due {lead.followUpDate}</span>
            </div>
            <p className="mt-1 text-sm text-slate-600">{lead.serviceType} • {lead.phone} • {lead.status}</p>
            <p className="mt-2 text-sm text-slate-600">{lead.notes}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
