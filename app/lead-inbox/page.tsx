import Link from "next/link";
import { leads } from "@/data/mockData";

const urgencyStyles = {
  High: "bg-red-100 text-red-700",
  Medium: "bg-amber-100 text-amber-700",
  Low: "bg-emerald-100 text-emerald-700",
};

const statusStyles = {
  New: "bg-blue-100 text-blue-700",
  Contacted: "bg-indigo-100 text-indigo-700",
  "Estimate Sent": "bg-violet-100 text-violet-700",
  Booked: "bg-emerald-100 text-emerald-700",
};

const sourceStyles = {
  "Missed Call": "bg-slate-100 text-slate-700",
  "Website Form": "bg-cyan-100 text-cyan-700",
  Facebook: "bg-blue-100 text-blue-700",
  "Google Business Profile": "bg-green-100 text-green-700",
};

export default function LeadInboxPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Lead Inbox</h1>
          <p className="text-slate-600">Every inbound opportunity, prioritized by urgency and booking status.</p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              {["Customer", "Service", "Source", "Urgency", "Status", "Last Message", "Details"].map((h) => (
                <th key={h} className="px-4 py-3 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id} className="border-t border-slate-100 hover:bg-slate-50/80">
                <td className="px-4 py-4 font-semibold text-slate-900">
                  {lead.customerName}
                  <p className="mt-1 text-xs font-normal text-slate-500">{lead.lastContactAt}</p>
                </td>
                <td className="px-4 py-4 text-slate-700">{lead.tradeType}: {lead.serviceNeeded}</td>
                <td className="px-4 py-4"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${sourceStyles[lead.source]}`}>{lead.source}</span></td>
                <td className="px-4 py-4"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${urgencyStyles[lead.urgency]}`}>{lead.urgency}</span></td>
                <td className="px-4 py-4"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${statusStyles[lead.status]}`}>{lead.status}</span></td>
                <td className="max-w-xs px-4 py-4 text-slate-600">{lead.lastMessage}</td>
                <td className="px-4 py-4">
                  <Link className="font-semibold text-blue-600 hover:text-blue-800 hover:underline" href={`/leads/${lead.id}`}>
                    View Lead →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
