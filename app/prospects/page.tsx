export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getUser } from "@/lib/auth";
import { listProspects } from "@/lib/prospects/service";

export default async function ProspectsPage() {
  const user = await getUser();
  if (!user) redirect("/auth/login");

  const prospects = await listProspects();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Prospects</h1>
        <p className="text-slate-600">Inbound audit requests from the AI BackOffice landing page.</p>
      </div>

      <div className="grid gap-4">
        {prospects.length === 0 && (
          <p className="text-sm text-slate-500">No prospects yet. Once the landing page audit form is wired to /api/prospects/intake, submissions will appear here.</p>
        )}
        {prospects.map((prospect) => (
          <div key={prospect.id} className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-slate-900">{prospect.business_name}</h2>
              <span className="rounded-full bg-blue-100 px-2 py-1 text-xs font-semibold text-blue-700">{prospect.status}</span>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              {prospect.contact_name || "No contact name"} &bull; {prospect.email || "No email"} &bull; {prospect.phone || "No phone"}
            </p>
            {prospect.message && <p className="mt-2 text-sm text-slate-600">{prospect.message}</p>}
            <p className="mt-2 text-xs text-slate-400">Submitted {new Date(prospect.created_at).toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
