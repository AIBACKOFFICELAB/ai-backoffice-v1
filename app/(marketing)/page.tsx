import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AUDIT_URL } from "@/lib/constants";

const painFixPairs = [
  {
    pain: "A missed call after 5 PM turns into a job your competitor books first thing in the morning.",
    fix: "Every missed call gets an instant text-back with your booking link — day or night.",
  },
  {
    pain: "Leads from web forms and social ads sit for hours before anyone replies.",
    fix: "New leads land in one inbox, sorted by urgency, the moment they come in.",
  },
  {
    pain: "Unsigned estimates get forgotten instead of followed up on.",
    fix: "Open estimates get automatic Day 1 / 3 / 7 follow-up until they close or die.",
  },
  {
    pain: "Review requests happen only when someone remembers to send them.",
    fix: "Completed jobs are flagged for a review request the moment they're marked done.",
  },
];

const steps = [
  {
    title: "Capture every inquiry",
    description: "Missed calls, website forms, and message leads land in one inbox so nothing gets lost.",
  },
  {
    title: "Respond and follow up automatically",
    description: "Callers get an instant text-back; open estimates get a Day 1/3/7 reminder sequence until they close.",
  },
  {
    title: "See where revenue is stuck",
    description: "Your dashboard flags emergency leads, overdue follow-ups, and pending reviews — the daily worklist writes itself.",
  },
];

const trades = ["Plumbers", "HVAC Teams", "Electricians", "Roofers", "Cleaning Companies"];

const faqs = [
  {
    q: "Does this replace my receptionist or dispatcher?",
    a: "No — it catches what falls through today: after-hours calls, quiet web leads, and estimates nobody got back to. If you have staff answering calls, this backs them up instead of replacing them.",
  },
  {
    q: "What actually happens when a call comes in after hours?",
    a: "The caller gets an immediate text with your booking link and, if it's flagged urgent, emergency instructions. You get notified by SMS and email the moment it happens, with the full context waiting in your Lead Inbox.",
  },
  {
    q: "Do I need new phone hardware or a new number?",
    a: "No — it runs on your existing business line. Setup is a configuration step, not a hardware swap.",
  },
  {
    q: "Can I control what the automated text says?",
    a: "Yes. The recovery message, your emergency line, and your intake form link are all editable from Settings, with a preview before anything goes live.",
  },
];

export default function HomePage() {
  return (
    <div>
      <section className="relative overflow-hidden bg-gradient-to-b from-brand-950 to-brand-900 text-white">
        <div className="mx-auto max-w-page px-5 py-20 sm:px-8 sm:py-28">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-brand-200">
            Built for home service contractors
          </p>
          <h1 className="mt-5 max-w-3xl text-4xl font-extrabold leading-[1.1] tracking-tight sm:text-5xl lg:text-[56px]">
            Every missed call is a job your competitor just booked.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-brand-100 sm:text-xl">
            AI BackOffice answers the call, chases the unsigned estimate, and asks for the review — automatically.
            A two-person crew runs its front office like it has a full-time dispatcher.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <Button href={AUDIT_URL} target="_blank" rel="noopener noreferrer" size="lg">
              Get My Free Missed-Call Audit
            </Button>
            <Button href="#how-it-works" variant="outline" size="lg">
              See how it works
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-page px-5 py-16 sm:px-8 sm:py-20">
        <h2 className="text-2xl font-bold sm:text-3xl">Where the jobs are actually leaking</h2>
        <p className="mt-2 max-w-2xl text-ink-500">Four real failure points, and what closes each one.</p>
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
          <p className="mt-2 max-w-2xl text-ink-500">Three steps, running continuously in the background.</p>
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
          <h2 className="text-2xl font-bold sm:text-3xl">Get your free missed-call audit</h2>
          <p className="mt-2 text-ink-500">
            We&apos;ll show you exactly how many jobs are slipping through — no cost, no commitment.
          </p>
          <Card className="mt-8 flex flex-col items-center gap-5 p-8">
            <p className="max-w-md text-[15px] text-ink-700">
              Audits are run through our business intelligence partner — tell them a bit about your business and
              they&apos;ll walk you through where revenue is leaking.
            </p>
            <Button href={AUDIT_URL} target="_blank" rel="noopener noreferrer" size="lg">
              Start My Free Audit
            </Button>
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
