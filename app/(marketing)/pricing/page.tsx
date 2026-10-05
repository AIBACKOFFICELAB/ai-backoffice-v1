import type { Metadata } from "next";
import { Card } from "@/components/ui/Card";
import { FounderBetaCheckoutButton } from "@/components/FounderBetaCheckoutButton";

export const metadata: Metadata = {
  title: "Pricing",
  description: "AI BackOffice Founder Beta — $299/month, $0 setup, one business, Founder-assisted onboarding, Estimate Closing intelligence.",
};

const included = [
  "Estimate Closing intelligence: see which open estimates need attention and why",
  "Evidence-backed recommendations for you to review and act on",
  "Lead and estimate visibility in one workspace",
  "Follow-through tracking and outcome evidence timeline",
  "Founder-assisted onboarding — we connect your data with you",
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-page px-5 py-16 sm:px-8 sm:py-20">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-bold tracking-tight text-ink-900 sm:text-4xl">AI BackOffice Founder Beta</h1>
        <p className="mt-3 text-lg text-ink-500">One simple plan for home service contractors who send estimates and want more of them to close.</p>
      </div>

      <Card tone="dark" className="mx-auto mt-12 flex max-w-xl flex-col p-8">
        <p className="flex items-baseline gap-1">
          <span className="text-5xl font-extrabold tracking-tight">$299</span>
          <span className="text-brand-200">/month</span>
        </p>
        <p className="mt-2 text-sm text-brand-200">$0 setup during Founder Beta · One business · Month-to-month</p>
        <ul className="mt-6 space-y-3 text-sm text-brand-100">
          {included.map((point) => (
            <li key={point} className="flex gap-2.5">
              <svg className="mt-0.5 h-4 w-4 shrink-0 text-gold-300" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7 7a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 111.4-1.4L8.5 11l6.3-6.3a1 1 0 011.4 0z" clipRule="evenodd" />
              </svg>
              {point}
            </li>
          ))}
        </ul>
        <div className="mt-8"><FounderBetaCheckoutButton variant="secondary" className="w-full" /></div>
      </Card>

      <div className="mx-auto mt-8 max-w-xl space-y-2 text-center text-sm text-ink-500">
        <p><strong>Shadow mode:</strong> AI BackOffice recommends and you decide. It does not send messages to your customers on its own.</p>
        <p>Founder Beta pricing applies during the beta. No revenue or close-rate results are guaranteed. Cancel any time.</p>
      </div>
    </div>
  );
}
