import Link from "next/link";

const painPoints = [
  "Missed calls after 5 PM turn into jobs your competitor books first thing in the morning.",
  "Leads from web forms and social ads sit too long without a response.",
  "Unsold estimates get forgotten instead of followed up automatically.",
  "Review requests are inconsistent, costing trust and referral volume.",
];

const howItWorks = [
  {
    title: "Capture every inquiry",
    description: "AI BackOffice logs missed calls, website forms, and message leads in one inbox so no opportunity gets lost.",
  },
  {
    title: "Respond and follow up fast",
    description: "AI drafts replies and sends timely reminders so your team can move leads from inquiry to estimate to booked job.",
  },
  {
    title: "Recover missed revenue",
    description: "Your dashboard highlights money left on the table and gives clear daily actions to close more work.",
  },
];

const trades = ["Plumbers", "HVAC Teams", "Electricians", "Roofers", "Cleaning Companies"];

export default function HomePage() {
  return (
    <div className="space-y-12 md:space-y-16">
      <section className="rounded-3xl bg-gradient-to-br from-slate-950 to-blue-900 p-8 text-white shadow-xl md:p-12">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-blue-200">Built for Home Service Contractors</p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight md:text-5xl">Turn missed calls into booked jobs with your AI-powered back office.</h1>
        <p className="mt-4 max-w-3xl text-lg text-blue-100">
          AI BackOffice helps service businesses respond faster, organize every inquiry, follow up on estimates, and keep office workload under control—without hiring more admin staff.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/dashboard" className="rounded-xl bg-white px-5 py-3 font-semibold text-slate-900 transition hover:bg-blue-50">Open Demo Dashboard</Link>
          <Link href="/pricing" className="rounded-xl border border-blue-200/60 px-5 py-3 font-semibold text-white transition hover:bg-white/10">View Contractor Plans</Link>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-2xl font-semibold text-slate-900">Why contractors lose jobs today</h2>
          <ul className="mt-4 space-y-3 text-slate-600">
            {painPoints.map((point) => (
              <li key={point}>• {point}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl bg-blue-50 p-6 shadow-sm ring-1 ring-blue-100">
          <h2 className="text-2xl font-semibold text-slate-900">What AI BackOffice fixes</h2>
          <p className="mt-4 text-slate-700">
            One command center for inbound leads, automated follow-ups, estimate reminders, and review requests—so field crews stay focused while AI keeps your pipeline moving.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold text-slate-900">How AI BackOffice works</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {howItWorks.map((step, index) => (
            <div key={step.title} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <p className="text-sm font-semibold text-blue-600">Step {index + 1}</p>
              <h3 className="mt-2 text-lg font-semibold text-slate-900">{step.title}</h3>
              <p className="mt-2 text-sm text-slate-600">{step.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-2xl font-semibold text-slate-900">Built for the trades you serve every day</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {trades.map((trade) => (
            <div key={trade} className="rounded-xl bg-slate-50 px-4 py-3 text-center text-sm font-semibold text-slate-700 ring-1 ring-slate-200">
              {trade}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
