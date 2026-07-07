export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { listProspects } from "@/lib/prospects/service";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export default async function ProspectsPage() {
  const user = await getUser();
  if (!user) redirect("/auth/login");

  const prospects = await listProspects();

  return (
    <div className="space-y-6">
      <PageHeader title="Prospects" description="Inbound audit requests from the marketing site." />

      {prospects.length === 0 ? (
        <EmptyState
          title="No prospects yet"
          description="Submissions from the homepage's free-audit form will appear here."
        />
      ) : (
        <div className="grid gap-4">
          {prospects.map((prospect) => (
            <Card key={prospect.id} className="p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold text-ink-900">{prospect.business_name}</h2>
                <span className="rounded-pill bg-brand-100 px-2.5 py-1 text-xs font-semibold text-brand-800">
                  {prospect.status}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink-500">
                {prospect.contact_name || "No contact name"} &bull; {prospect.email || "No email"} &bull; {prospect.phone || "No phone"}
              </p>
              {prospect.message && <p className="mt-2 text-sm text-ink-500">{prospect.message}</p>}
              <p className="mt-2 text-xs text-ink-400">Submitted {new Date(prospect.created_at).toLocaleString()}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
