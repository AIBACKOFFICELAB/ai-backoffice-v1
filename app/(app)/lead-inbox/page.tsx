export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getLeads } from "@/lib/leads/repository";
import { getTenantContext } from "@/lib/tenant";
import { LeadInboxList } from "@/components/LeadInboxList";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function LeadInboxPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");

  const { leads } = await getLeads(tenant.tenantId);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lead Inbox"
        description={`${tenant.tenantName} · Service Request Form → Google Sheet → Lead Inbox.`}
      />
      <LeadInboxList leads={leads} />
    </div>
  );
}
