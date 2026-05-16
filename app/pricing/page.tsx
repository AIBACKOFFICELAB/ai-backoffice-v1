const tiers = [
  {
    name: "Starter",
    price: "$129/mo",
    value: "Best for owner-operators handling calls themselves",
    points: [
      "Capture up to 80 inbound leads/month",
      "AI missed-call text-back within minutes",
      "Basic estimate follow-up reminders",
      "Review request templates for completed jobs",
    ],
  },
  {
    name: "Growth",
    price: "$299/mo",
    value: "Best for teams ready to close more jobs every month",
    points: [
      "Capture up to 300 inbound leads/month",
      "Automated follow-up sequences for open estimates",
      "Lead inbox with urgency + source prioritization",
      "AI daily recommendations to recover lost revenue",
    ],
    recommended: true,
  },
  {
    name: "Pro",
    price: "$549/mo",
    value: "Best for multi-crew contractors scaling across service areas",
    points: [
      "Unlimited lead capture",
      "Advanced pipeline and missed revenue tracking",
      "Priority onboarding and workflow setup",
      "Team-level visibility across office and field operations",
    ],
  },
];

export default function PricingPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-slate-900">Pricing for Home Service Contractors</h1>
      <p className="text-slate-600">Choose the plan that helps your team respond faster, reduce office overload, and book more profitable jobs.</p>

      <div className="grid gap-4 md:grid-cols-3">
        {tiers.map((tier) => (
          <div
            key={tier.name}
            className={`relative rounded-2xl p-6 shadow-sm ring-1 ${tier.recommended ? "bg-slate-900 text-white ring-slate-800" : "bg-white text-slate-900 ring-slate-200"}`}
          >
            {tier.recommended ? (
              <span className="absolute -top-3 left-6 rounded-full bg-blue-500 px-3 py-1 text-xs font-semibold text-white">Most Popular</span>
            ) : null}
            <h2 className="text-xl font-semibold">{tier.name}</h2>
            <p className="mt-2 text-3xl font-bold">{tier.price}</p>
            <p className={`mt-1 text-sm ${tier.recommended ? "text-slate-300" : "text-slate-500"}`}>{tier.value}</p>
            <ul className={`mt-4 space-y-2 text-sm ${tier.recommended ? "text-slate-200" : "text-slate-600"}`}>
              {tier.points.map((point) => (
                <li key={point}>• {point}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
