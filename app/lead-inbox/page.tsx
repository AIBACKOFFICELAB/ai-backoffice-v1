import Link from "next/link";
import { leads } from "@/data/mockData";

export default function LeadInboxPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Lead Inbox</h1>
        <p className="text-slate-600">Track every inbound opportunity from first contact to booked job.</p>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-100 text-slate-600">
            <tr>
              {['Customer','Trade/Service','Source','Urgency','Status','Last Message','Details'].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {leads.map((lead) => (
              <tr key={lead.id} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium">{lead.customerName}</td>
                <td className="px-4 py-3">{lead.tradeType}: {lead.serviceNeeded}</td>
                <td className="px-4 py-3">{lead.source}</td>
                <td className="px-4 py-3">{lead.urgency}</td>
                <td className="px-4 py-3">{lead.status}</td>
                <td className="px-4 py-3">{lead.lastMessage}</td>
                <td className="px-4 py-3"><Link className="text-blue-600 hover:underline" href={`/leads/${lead.id}`}>Open</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
