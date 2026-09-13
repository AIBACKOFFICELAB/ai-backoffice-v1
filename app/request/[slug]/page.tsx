import { notFound } from "next/navigation";
import { resolvePublicIntakeTenant } from "@/lib/leads/intake/server";
import { LeadIntakeForm } from "@/components/LeadIntakeForm";
export const dynamic = "force-dynamic";
export const metadata = { title: "Request service", robots: { index: false, follow: false } };
export default async function ServiceRequestPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await resolvePublicIntakeTenant(slug);
  if (!tenant) notFound();
  return <main className="min-h-screen bg-surface px-4 py-10 sm:px-6">
    <div className="mx-auto max-w-2xl space-y-6">
      <header><p className="text-sm font-semibold text-brand-700">{tenant.name}</p>
        <h1 className="mt-2 text-3xl font-bold text-ink-900">Request service</h1>
        <p className="mt-3 text-ink-700">Tell us what you need help with. Your preferred time is a request; the team will confirm availability.</p>
      </header>
      <LeadIntakeForm endpoint={`/api/request/${encodeURIComponent(slug)}`} />
      <p className="text-center text-sm text-ink-500">Powered by AI BackOffice</p>
    </div>
  </main>;
}
