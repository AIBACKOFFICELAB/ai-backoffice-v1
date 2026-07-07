export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import Link from "next/link";
import { buildLeadMetrics, getLeads } from "@/lib/leads/repository";
import { getTenantContext } from "@/lib/tenant";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export default async function ReviewRequestsPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const { leads } = await getLeads(tenant.tenantId);
  const { reviewVisibleStatuses } = buildLeadMetrics(leads);
  const visibleLeads = leads.filter((lead) => reviewVisibleStatuses.includes(lead.reviewRequestStatus));

  return (
    <div className="space-y-6">
      <PageHeader title="Review Requests" description="Track which completed jobs are ready, sent, and converted into reviews." />

      <div className="grid gap-4 md:grid-cols-3">
        {reviewVisibleStatuses.map((status) => (
          <Card key={status} className="p-5">
            <p className="text-sm text-ink-500">{status}</p>
            <p className="mt-1 text-3xl font-bold text-ink-900">
              {visibleLeads.filter((lead) => lead.reviewRequestStatus === status).length}
            </p>
          </Card>
        ))}
      </div>

      {visibleLeads.length === 0 ? (
        <EmptyState
          title="No review requests yet"
          description="Completed jobs ready for a review request will show up here."
        />
      ) : (
        <div className="grid gap-4">
          {visibleLeads.map((lead) => (
            <Link key={lead.id} href={`/leads/${lead.id}`} className="block">
              <Card className="p-5 transition hover:shadow-raised">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-semibold text-ink-900">{lead.customerName}</h2>
                  <span className="rounded-pill bg-brand-100 px-2.5 py-1 text-xs font-semibold text-brand-800">
                    {lead.reviewRequestStatus}
                  </span>
                </div>
                <p className="mt-1 text-sm text-ink-500">
                  {lead.serviceType} &bull; {lead.status}
                </p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
