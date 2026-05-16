const ready = ["Sharon Patel", "Liam Thompson", "Erica Nguyen"];
const sent = ["Carlos Diaz — sent 3h ago", "Nina Brooks — sent yesterday", "Tony Webb — sent yesterday"];

export default function ReviewRequestsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Review Requests</h1>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm text-slate-500">Requests Sent</p><p className="text-3xl font-bold">41</p>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm text-slate-500">Response Rate</p><p className="text-3xl font-bold">63%</p>
        </div>
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <p className="text-sm text-slate-500">New 5★ Reviews</p><p className="text-3xl font-bold">18</p>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200"><h2 className="font-semibold">Ready to Request</h2><ul className="mt-3 space-y-2 text-sm text-slate-600">{ready.map((n)=><li key={n}>• {n}</li>)}</ul></div>
        <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200"><h2 className="font-semibold">Recently Sent</h2><ul className="mt-3 space-y-2 text-sm text-slate-600">{sent.map((n)=><li key={n}>• {n}</li>)}</ul></div>
      </div>
    </div>
  );
}
