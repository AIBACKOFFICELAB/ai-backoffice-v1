import { aiRecommendations, dashboardStats, recentActivity } from "@/data/mockData";

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <section className="rounded-2xl bg-slate-900 p-6 text-white shadow-lg ring-1 ring-slate-800">
        <h1 className="text-3xl font-bold">Revenue Command Center</h1>
        <p className="mt-2 text-slate-300">Track lead response speed, estimate follow-up, and money left on the table in one place.</p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {dashboardStats.map((stat) => (
          <div key={stat.label} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm font-semibold text-slate-500">{stat.label}</p>
            <p className="mt-2 text-3xl font-bold text-slate-900">{stat.value}</p>
            <p className="mt-1 text-xs text-slate-500">{stat.trend}</p>
            <p className="mt-3 rounded-lg bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">{stat.impact}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-xl font-semibold text-slate-900">Recent Activity</h2>
          <ul className="mt-4 space-y-3 text-sm text-slate-600">
            {recentActivity.map((item) => (
              <li key={item} className="rounded-lg bg-slate-50 p-3">{item}</li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-xl font-semibold text-slate-900">AI Recommendations</h2>
          <ul className="mt-4 space-y-3 text-sm text-slate-600">
            {aiRecommendations.map((item) => (
              <li key={item} className="rounded-lg border border-blue-100 bg-blue-50 p-3">{item}</li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
