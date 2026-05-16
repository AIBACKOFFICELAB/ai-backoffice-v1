import Link from "next/link";

const problems = [
  "Missed calls after hours become lost revenue by morning.",
  "Slow follow-up lets faster competitors win the job.",
  "Forgotten estimates stall your sales pipeline.",
  "Weak review systems limit referrals and trust.",
];

const features = [
  "24/7 AI lead response by text and email",
  "Smart follow-up sequences for estimates",
  "Review request automation after completed jobs",
  "Simple dashboard built for service contractors",
];

export default function HomePage() {
  return (
    <div className="space-y-16">
      <section className="rounded-3xl bg-white p-8 shadow-sm ring-1 ring-slate-200 md:p-12">
        <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">Built for Contractors</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-5xl">Stop losing contractor leads after hours.</h1>
        <p className="mt-4 max-w-3xl text-lg text-slate-600">
          AI BackOffice helps plumbers, HVAC companies, electricians, roofers, and home service contractors capture missed leads, follow up faster, request reviews, and close more jobs.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/dashboard" className="rounded-xl bg-blue-600 px-5 py-3 font-semibold text-white hover:bg-blue-700">View Dashboard</Link>
          <Link href="/pricing" className="rounded-xl border border-slate-300 px-5 py-3 font-semibold text-slate-700 hover:bg-slate-100">See Pricing</Link>
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-2xl font-semibold">The Problem</h2>
          <ul className="mt-4 space-y-3 text-slate-600">
            {problems.map((problem) => (
              <li key={problem}>• {problem}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-2xl font-semibold">The AI BackOffice Solution</h2>
          <p className="mt-4 text-slate-600">
            One central operating system for inbound leads, automated follow-ups, open estimates, and review generation—so your team can focus on field work while AI handles repeatable office tasks.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold">Core Features for Growing Service Businesses</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {features.map((feature) => (
            <div key={feature} className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
              <p className="font-medium text-slate-800">{feature}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
