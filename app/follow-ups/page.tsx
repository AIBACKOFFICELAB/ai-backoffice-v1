const automations = [
  { name: "Missed Call Follow-Up", detail: "Send text within 2 minutes after missed call.", enabled: true },
  { name: "Estimate Reminder", detail: "Remind leads 24 hours after estimate sent.", enabled: true },
  { name: "No Response Follow-Up", detail: "3-touch sequence over 5 days.", enabled: false },
  { name: "Review Request", detail: "Send review link 2 hours after completed job.", enabled: true },
];

export default function FollowUpsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Follow-Up Automations</h1>
      <div className="grid gap-4 md:grid-cols-2">
        {automations.map((item) => (
          <div key={item.name} className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{item.name}</h2>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${item.enabled ? 'bg-green-100 text-green-700' : 'bg-slate-200 text-slate-600'}`}>
                {item.enabled ? 'On' : 'Off'}
              </span>
            </div>
            <p className="mt-2 text-sm text-slate-600">{item.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
