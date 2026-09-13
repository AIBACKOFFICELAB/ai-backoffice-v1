import { redirect } from "next/navigation";
import { getTenantContext } from "@/lib/tenant";
import { LeadIntakeForm } from "@/components/LeadIntakeForm";
import { PageHeader } from "@/components/ui/PageHeader";
export const dynamic = "force-dynamic";
export default async function NewLeadPage() {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");
  return <div className="max-w-2xl space-y-6"><PageHeader title="New lead" description={`${tenant.tenantName} · Record a phone, walk-in, or referral request.`} /><LeadIntakeForm endpoint="/api/leads" manual /></div>;
}
