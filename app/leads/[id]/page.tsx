import { notFound } from "next/navigation";
import { leads } from "@/data/mockData";

const timeline = [
  { time: "8:12 AM", type: "Customer", message: "Our water heater stopped working last night." },
  { time: "8:14 AM", type: "AI BackOffice", message: "Thanks for reaching out. We can help today. What is your address?" },
  { time: "8:16 AM", type: "Customer", message: "412 Birch Lane. Can someone come Thursday?" },
  { time: "8:20 AM", type: "Office", message: "Yes. We can come Thursday 2–4 PM. Estimate is on the way." },
];

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lead = leads.find((item) => item.id === id);
  if (!lead) notFound();

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-3xl font-bold text-slate-900">Lead Detail: {lead.customerName}</h1>
        <p className="mt-2 text-slate-600">Keep this lead moving from inquiry to booked job with fast, clear next actions.</p>
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <h2 className="font-semibold text-slate-900">Customer Profile</h2>
          <p className="mt-3 text-sm text-slate-600">{lead.phone}</p>
          <p className="text-sm text-slate-600">{lead.email}</p>
          <p className="text-sm text-slate-600">{lead.address}</p>
        </div>

        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200 lg:col-span-2">
          <h2 className="font-semibold text-slate-900">Job Summary</h2>
          <div className="mt-3 grid gap-2 text-sm text-slate-600 md:grid-cols-2">
            <p><span className="font-semibold text-slate-900">Service:</span> {lead.tradeType} — {lead.serviceNeeded}</p>
            <p><span className="font-semibold text-slate-900">Urgency:</span> {lead.urgency}</p>
            <p><span className="font-semibold text-slate-900">Lead Status:</span> {lead.status}</p>
            <p><span className="font-semibold text-slate-900">Last Contact:</span> {lead.lastContactAt}</p>
            <p><span className="font-semibold text-slate-900">Estimate:</span> {lead.estimateAmount}</p>
            <p><span className="font-semibold text-slate-900">Estimate Status:</span> {lead.estimateStatus}</p>
          </div>
        </div>
      </div>

      <section className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
        <h2 className="font-semibold text-slate-900">Message Timeline</h2>
        <ul className="mt-4 space-y-3 text-sm">
          {timeline.map((item) => (
            <li key={`${item.time}-${item.message}`} className="rounded-lg bg-slate-50 p-3 text-slate-700">
              <span className="font-semibold text-slate-900">{item.time} • {item.type}:</span> {item.message}
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-5 shadow-sm">
          <h2 className="font-semibold text-slate-900">AI Suggested Reply</h2>
          <p className="mt-2 text-sm text-slate-700">
            "Great news—we can reserve your Thursday 2–4 PM window today. If you approve the estimate now, we can prioritize same-week installation. Want me to send the booking link?"
          </p>
        </div>
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-5 shadow-sm">
          <h2 className="font-semibold text-slate-900">Missed Revenue Opportunity</h2>
          <p className="mt-2 text-sm text-slate-700">If this lead is not followed up again today, you risk losing {lead.estimateAmount} to a faster competitor.</p>
        </div>
      </section>

      <div className="flex flex-wrap gap-3">
        {[
          "Send Follow-Up",
          "Mark Booked",
          "Send Review Request",
        ].map((action) => (
          <button key={action} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700">
            {action}
          </button>
        ))}
      </div>
    </div>
  );
}
