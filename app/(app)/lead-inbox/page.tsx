export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getLeads } from "@/lib/leads/repository";
import { getTenantContext } from "@/lib/tenant";
import { LeadInboxList } from "@/components/LeadInboxList";
import { Button } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function LeadInboxPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const { leads, error } = await getLeads(tenant.tenantId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lead Inbox"
        actions={<Button href="/leads/new">New lead</Button>}
        description={`${tenant.tenantName} · Service Request → AI BackOffice → Lead Inbox.`}
      />
      {error ? <p role="alert" className="rounded-card bg-white p-5 text-ink-700">Lead Inbox is temporarily unavailable. Please refresh to try again.</p> : <LeadInboxList leads={leads} />}
    </div>
  );
}
