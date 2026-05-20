import Link from "next/link";
import { buildLeadMetrics, getLeads } from "@/lib/leads/repository";

export default async function ReviewRequestsPage() {
  const { leads } = await getLeads();
  const { reviewVisibleStatuses } = buildLeadMetrics(leads);
  const visibleLeads = leads.filter((lead) => reviewVisibleStatuses.includes(lead.reviewRequestStatus));

  return <div className="space-y-6"><h1 className="text-3xl font-bold">Review Requests</h1><p className="text-slate-600">Track which completed plumbing jobs are ready, sent, and converted into reviews.</p><div className="grid gap-4 md:grid-cols-3">{reviewVisibleStatuses.map((status) => (<div key={status} className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200"><p className="text-sm text-slate-500">{status}</p><p className="text-3xl font-bold">{visibleLeads.filter((lead) => lead.reviewRequestStatus === status).length}</p></div>))}</div><div className="grid gap-4">{visibleLeads.map((lead) => (<Link key={lead.id} href={`/leads/${lead.id}`} className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200"><div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{lead.customerName}</h2><span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">{lead.reviewRequestStatus}</span></div><p className="mt-1 text-sm text-slate-600">{lead.serviceType} • {lead.status}</p></Link>))}</div></div>;
}
