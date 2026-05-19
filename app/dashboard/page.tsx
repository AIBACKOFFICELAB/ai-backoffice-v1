import { plumbingLeads } from "@/data/plumbingLeads";

export default function DashboardPage() {
  const today = new Date().toISOString().slice(0, 10);
  const totalLeads = plumbingLeads.length;
  const newLeads = plumbingLeads.filter((lead) => lead.status === "New").length;
  const emergencyLeads = plumbingLeads.filter((lead) => lead.emergency === "Yes").length;
  const followUpsDue = plumbingLeads.filter((lead) => lead.followUpDate && lead.followUpDate <= today).length;
  const estimatesSent = plumbingLeads.filter((lead) => lead.status === "Estimate Sent").length;
  const jobsWon = plumbingLeads.filter((lead) => lead.status === "Won").length;
  const revenuePipeline = plumbingLeads
    .filter((lead) => !["Lost", "Completed"].includes(lead.status))
    .reduce((sum, lead) => sum + lead.estimateAmount, 0);
  const reviewPending = plumbingLeads.filter((lead) => lead.reviewRequestStatus === "Ready to Send").length;

  const metrics = [
    ["Total Leads", totalLeads],
    ["New Leads", newLeads],
    ["Emergency Leads", emergencyLeads],
    ["Follow-Ups Due", followUpsDue],
    ["Estimates Sent", estimatesSent],
    ["Jobs Won", jobsWon],
    ["Revenue Pipeline", `$${revenuePipeline.toLocaleString()}`],
    ["Review Requests Pending", reviewPending],
  ];

  return (
    <div className="space-y-8">
      <section className="rounded-2xl bg-slate-900 p-6 text-white shadow-lg ring-1 ring-slate-800">
        <h1 className="text-3xl font-bold">Revenue Command Center</h1>
        <p className="mt-2 text-slate-300">5 Star Plumbing private alpha dashboard powered by lead inbox data.</p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {metrics.map(([label, value]) => (
          <div key={String(label)} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold text-slate-500">{label}</p>
            <p className="mt-2 text-3xl font-bold text-slate-900">{value}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
