import type { Metadata } from "next";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AUDIT_URL } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Plans for home service contractors — missed-call recovery, estimate follow-up, and review requests.",
};

const tiers = [
  {
    name: "Starter",
    price: "$129",
    value: "For an owner-operator answering their own calls.",
    points: [
      "Capture up to 80 inbound leads/month",
      "Automated missed-call text-back within minutes",
      "Basic estimate follow-up reminders",
      "Review request templates for completed jobs",
    ],
  },
  {
    name: "Growth",
    price: "$299",
    value: "For a team ready to close more jobs every month.",
    points: [
      "Capture up to 300 inbound leads/month",
      "Automated follow-up sequences for open estimates",
      "Lead inbox with urgency + source prioritization",
      "Daily recommendations to recover stalled revenue",
    ],
    recommended: true,
  },
  {
    name: "Pro",
    price: "$549",
    value: "For businesses running 3+ crews across more than one town.",
    points: [
      "Unlimited lead capture",
      "Advanced pipeline and missed-revenue tracking",
      "Priority onboarding and workflow setup",
      "Team-level visibility across office and field",
    ],
  },
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-page px-5 py-16 sm:px-8 sm:py-20">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">Pricing for home service contractors</h1>
        <p className="mt-3 text-lg text-ink-500">
          Every plan is billed monthly. Start with a free audit — we&apos;ll recommend the tier that fits before you commit to anything.
        </p>
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {tiers.map((tier) => (
          <Card
            key={tier.name}
            tone={tier.recommended ? "dark" : "light"}
            className="relative flex flex-col p-7"
          >
            {tier.recommended && (
              <span className="absolute -top-3 left-7 rounded-pill bg-gold-400 px-3 py-1 text-xs font-bold text-brand-950">
                Most popular
              </span>
            )}
            <h2 className="text-lg font-semibold">{tier.name}</h2>
            <p className="mt-3 flex items-baseline gap-1">
              <span className="text-4xl font-extrabold tracking-tight">{tier.price}</span>
              <span className={tier.recommended ? "text-brand-200" : "text-ink-400"}>/mo</span>
            </p>
            <p className={`mt-2 text-sm ${tier.recommended ? "text-brand-200" : "text-ink-500"}`}>{tier.value}</p>

            <ul className={`mt-6 space-y-3 text-sm ${tier.recommended ? "text-brand-100" : "text-ink-700"}`}>
              {tier.points.map((point) => (
                <li key={point} className="flex gap-2.5">
                  <svg
                    className={`mt-0.5 h-4 w-4 shrink-0 ${tier.recommended ? "text-gold-300" : "text-brand-600"}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7 7a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 111.4-1.4L8.5 11l6.3-6.3a1 1 0 011.4 0z" clipRule="evenodd" />
                  </svg>
                  {point}
                </li>
              ))}
            </ul>

            <Button
              href={AUDIT_URL}
              target="_blank"
              rel="noopener noreferrer"
              variant={tier.recommended ? "secondary" : "primary"}
              className="mt-8 w-full"
            >
              Get started with {tier.name}
            </Button>
          </Card>
        ))}
      </div>

      <p className="mt-10 text-center text-sm text-ink-400">
        Not sure which plan fits?{" "}
        <a href={AUDIT_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 hover:underline">
          Book a free audit
        </a>{" "}
        and we&apos;ll recommend one.
      </p>
    </div>
  );
}
