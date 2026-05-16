import { aiRecommendations, dashboardStats, recentActivity } from "@/data/mockData";

export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <section>
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <p className="mt-1 text-slate-600">Your AI-powered back office snapshot for this week.</p>
      </section>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {dashboardStats.map((stat) => (
          <div key={stat.label} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <p className="text-sm text-slate-500">{stat.label}</p>
            <p className="mt-2 text-3xl font-bold">{stat.value}</p>
            <p className="mt-1 text-xs text-slate-500">{stat.trend}</p>
          </div>
        ))}
      </section>
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-xl font-semibold">Recent Activity</h2>
          <ul className="mt-4 space-y-3 text-sm text-slate-600">
            {recentActivity.map((item) => (
              <li key={item}>• {item}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h2 className="text-xl font-semibold">AI Recommendations</h2>
          <ul className="mt-4 space-y-3 text-sm text-slate-600">
            {aiRecommendations.map((item) => (
              <li key={item}>• {item}</li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
