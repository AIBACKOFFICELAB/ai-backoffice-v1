export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import Link from "next/link";
import { getLeads } from "@/lib/leads/repository";
import { getTenantContext } from "@/lib/tenant";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export default async function FollowUpsPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const today = new Date().toISOString().slice(0, 10);
  const { leads } = await getLeads(tenant.tenantId);
  const followUps = leads
    .filter((lead) => lead.followUpDate && lead.followUpDate <= today && !["Completed", "Lost"].includes(lead.status))
    .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));

  return (
    <div className="space-y-6">
      <PageHeader title="Follow-Ups Due" description="Leads that need a callback, estimate reminder, or scheduling confirmation." />

      {followUps.length === 0 ? (
        <EmptyState
          title="You're all caught up"
          description="No follow-ups are due right now — new ones will appear here as estimate dates come due."
        />
      ) : (
        <div className="grid gap-4">
          {followUps.map((lead) => (
            <Link key={lead.id} href={`/leads/${lead.id}`} className="block">
              <Card className="p-5 transition hover:shadow-raised">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-semibold text-ink-900">{lead.customerName}</h2>
                  <span className="rounded-pill bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">
                    Due {lead.followUpDate}
                  </span>
                </div>
                <p className="mt-1 text-sm text-ink-500">
                  {lead.serviceType} &bull; {lead.phone} &bull; {lead.status}
                </p>
                {lead.internalNotes && <p className="mt-2 text-sm text-ink-500">{lead.internalNotes}</p>}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
