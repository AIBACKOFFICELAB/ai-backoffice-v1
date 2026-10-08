import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FounderBetaCheckoutButton } from "@/components/FounderBetaCheckoutButton";

const painFixPairs = [
  {
    pain: "Estimates go out and then nobody knows which ones are quietly going cold.",
    fix: "See every open estimate ranked by what needs attention first, with the reason shown.",
  },
  {
    pain: "Follow-up depends on someone remembering — and on a busy week, nobody does.",
    fix: "Get a clear, evidence-backed recommendation for each estimate. You review it and decide.",
  },
  {
    pain: "You can't tell whether the follow-up you did actually moved a job forward.",
    fix: "A timeline shows what was recommended, what was done, and what happened next.",
  },
  {
    pain: "Leads and estimates live in separate places, so the full picture is always out of date.",
    fix: "Leads and estimates in one workspace, kept in sync during Founder-assisted onboarding.",
  },
];

const steps = [
  {
    title: "We connect your data with you",
    description: "Founder-assisted onboarding: we set up your business and connect your lead and estimate source together.",
  },
  {
    title: "AI BackOffice reads your open estimates",
    description: "It highlights the estimates most worth a follow-up and explains why, using your own data as evidence.",
  },
  {
    title: "You review and act",
    description: "Shadow mode: recommendations come to you. Nothing is sent to your customers automatically.",
  },
];

const trades = ["Plumbers", "HVAC Teams", "Electricians", "Roofers", "Cleaning Companies"];

const faqs = [
  {
    q: "Does AI BackOffice contact my customers for me?",
    a: "No. Founder Beta runs in Shadow mode: it recommends and you decide. It does not send texts or emails to your customers on its own.",
  },
  {
    q: "What does Founder Beta cost?",
    a: "$299 per month, month-to-month, with $0 setup during Founder Beta. It covers one business. Founder Beta pricing applies during the beta.",
  },
  {
    q: "What is Founder-assisted onboarding?",
    a: "A hands-on session where we connect your lead and estimate data and configure your workspace with you. It is included, and it starts automatically after you subscribe.",
  },
  {
    q: "Will it increase my close rate?",
    a: "We can't promise results. It is built to make sure no open estimate slips through unnoticed, and to show you the evidence behind each recommendation.",
  },
];

export default function HomePage() {
  return (
    <div>
      <section className="relative overflow-hidden bg-gradient-to-b from-brand-950 to-brand-900 text-white">
        <div className="mx-auto max-w-page px-5 py-20 sm:px-8 sm:py-28">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-brand-200">
            AI BackOffice Founder Beta — for home service contractors
          </p>
          <h1 className="mt-5 max-w-3xl text-4xl font-extrabold leading-[1.1] tracking-tight sm:text-5xl lg:text-[56px]">
            Know which open estimates are about to go cold — and what to do about each one.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-brand-100 sm:text-xl">
            Estimate Closing intelligence for your business: evidence-backed recommendations on the estimates worth a follow-up,
            delivered for your review. $299/month, $0 setup during Founder Beta, one business, Founder-assisted onboarding.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <FounderBetaCheckoutButton variant="secondary" />
            <Button href="#how-it-works" variant="outline" size="lg">
              See how it works
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-page px-5 py-16 sm:px-8 sm:py-20">
        <h2 className="text-2xl font-bold sm:text-3xl">Where estimates quietly stall</h2>
        <p className="mt-2 max-w-2xl text-ink-500">Four common failure points, and what Estimate Closing intelligence does about each.</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {painFixPairs.map((pair) => (
            <Card key={pair.pain} className="p-6">
              <p className="text-[15px] text-ink-700">{pair.pain}</p>
              <div className="mt-4 flex gap-2.5 rounded-control bg-emerald-50 p-3.5">
                <svg className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7 7a1 1 0 01-1.4 0l-3.5-3.5a1 1 0 111.4-1.4L8.5 11l6.3-6.3a1 1 0 011.4 0z" clipRule="evenodd" />
                </svg>
                <p className="text-sm font-medium text-emerald-900">{pair.fix}</p>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section id="how-it-works" className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-page px-5 sm:px-8">
          <h2 className="text-2xl font-bold sm:text-3xl">How AI BackOffice works</h2>
          <p className="mt-2 max-w-2xl text-ink-500">Three steps, with you in control.</p>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {steps.map((step, index) => (
              <Card key={step.title} className="p-6">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-700 text-sm font-bold text-white">
                  {index + 1}
                </span>
                <h3 className="mt-4 text-lg font-semibold text-ink-900">{step.title}</h3>
                <p className="mt-2 text-[15px] text-ink-500">{step.description}</p>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-page px-5 py-16 sm:px-8 sm:py-20">
        <h2 className="text-2xl font-bold sm:text-3xl">Built for the trades you already know</h2>
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {trades.map((trade) => (
            <div
              key={trade}
              className="rounded-control bg-white px-4 py-4 text-center text-sm font-semibold text-ink-700 shadow-xs ring-1 ring-surface-border"
            >
              {trade}
            </div>
          ))}
        </div>
      </section>

      <section id="faq" className="bg-white py-16 sm:py-20">
        <div className="mx-auto max-w-page px-5 sm:px-8">
          <h2 className="text-2xl font-bold sm:text-3xl">Common questions</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {faqs.map((item) => (
              <div key={item.q}>
                <h3 className="text-[15px] font-semibold text-ink-900">{item.q}</h3>
                <p className="mt-1.5 text-[15px] text-ink-500">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="get-started" className="mx-auto max-w-page px-5 py-16 sm:px-8 sm:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-bold sm:text-3xl">Join AI BackOffice Founder Beta</h2>
          <p className="mt-2 text-ink-500">$299/month · $0 setup during Founder Beta · One business · Founder-assisted onboarding</p>
          <Card className="mt-8 flex flex-col items-center gap-5 p-8">
            <p className="max-w-md text-[15px] text-ink-700">
              Subscribe, set your password, and we&apos;ll schedule your onboarding. Shadow mode: AI BackOffice recommends, you decide.
              No results are guaranteed.
            </p>
            <FounderBetaCheckoutButton />
          </Card>
          <p className="mt-6 text-sm text-ink-400">
            Already a customer?{" "}
            <Link href="/auth/login" className="font-medium text-brand-700 hover:underline">
              Log in
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
