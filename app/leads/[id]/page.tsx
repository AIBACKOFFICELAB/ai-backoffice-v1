import { notFound } from "next/navigation";
import { leads } from "@/data/mockData";

const messages = [
  "Customer: Our water heater stopped working last night.",
  "AI BackOffice: Thanks for reaching out. We can help today—what's your address?",
  "Customer: 412 Birch Lane. Can someone come Thursday?",
  "Office: We can come Thursday 2-4 PM. Sending estimate now.",
];

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lead = leads.find((item) => item.id === id);
  if (!lead) notFound();

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Lead Detail: {lead.customerName}</h1>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="font-semibold">Customer Profile</h2>
          <p className="mt-2 text-sm text-slate-600">{lead.phone} • {lead.email}</p>
          <p className="text-sm text-slate-600">{lead.address}</p>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="font-semibold">Job Details</h2>
          <p className="mt-2 text-sm text-slate-600">{lead.tradeType}: {lead.serviceNeeded}</p>
          <p className="text-sm text-slate-600">Urgency: {lead.urgency}</p>
          <p className="text-sm text-slate-600">Last contact: {lead.lastContactAt}</p>
        </div>
      </div>
      <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="font-semibold">Message History</h2>
        <ul className="mt-3 space-y-2 text-sm text-slate-600">{messages.map((msg) => <li key={msg}>• {msg}</li>)}</ul>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="font-semibold">AI Recommended Follow-Up</h2>
          <p className="mt-2 text-sm text-slate-600">Send a same-day install option with financing language to improve close probability by 18%.</p>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="font-semibold">Estimate Status</h2>
          <p className="mt-2 text-sm text-slate-600">{lead.estimateStatus} • {lead.estimateAmount}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        {['Call','Text','Send Follow-Up','Mark Booked'].map((a) => <button key={a} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">{a}</button>)}
      </div>
    </div>
  );
}
