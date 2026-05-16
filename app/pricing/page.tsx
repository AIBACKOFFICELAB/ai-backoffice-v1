const tiers = [
  { name: "Starter", price: "$99/mo", value: "For owner-operators", points: ["Up to 60 leads/month", "AI missed-call texts", "Basic follow-up templates"] },
  { name: "Growth", price: "$249/mo", value: "For teams scaling revenue", points: ["Up to 250 leads/month", "Estimate reminder automation", "Review request workflows"] },
  { name: "Pro", price: "$499/mo", value: "For multi-crew contractors", points: ["Unlimited leads", "Advanced AI recommendations", "Priority onboarding support"] },
];

export default function PricingPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Pricing</h1>
      <p className="text-slate-600">Simple plans designed for contractors who want to close more jobs without hiring extra office staff.</p>
      <div className="grid gap-4 md:grid-cols-3">
        {tiers.map((tier) => (
          <div key={tier.name} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
            <h2 className="text-xl font-semibold">{tier.name}</h2>
            <p className="mt-2 text-3xl font-bold">{tier.price}</p>
            <p className="mt-1 text-sm text-slate-500">{tier.value}</p>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">{tier.points.map((p)=><li key={p}>• {p}</li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}
