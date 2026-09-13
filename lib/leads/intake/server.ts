import "server-only";
import { createClient } from "@supabase/supabase-js";
import { emitEvent } from "@/lib/events/service";
import { SupabaseBusinessEventStore } from "@/lib/events/store";
import { mapLeadToRow, mapRowToLead, type LeadRow } from "@/lib/leads/supabase";
import { sendEmail } from "@/lib/email/resend";
import { withTelemetryDeadline } from "@/lib/telemetry/deadline";
import type { IntakeDeps, IntakeTenant } from "./service";
import { validPublicSlug } from "./validation";

// Cookie-free: a visitor's session cannot replace the elevated Authorization header.
// Private to this narrow adapter; no privileged client exported to application consumers.
function intakeClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Intake database unavailable");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) }) } });
}
export async function resolvePublicIntakeTenant(slug: string): Promise<IntakeTenant | null> {
  if (!validPublicSlug(slug)) return null;
  const { data, error } = await intakeClient().from("tenants").select("id,name,email").eq("slug", slug).eq("status", "active").maybeSingle();
  if (error) throw new Error("Intake tenant lookup unavailable");
  return data;
}
export function createLiveIntakeDeps(): IntakeDeps {
  return {
    async persist(lead, tenantId) {
      const db = intakeClient();
      const { data, error } = await db.from("leads").insert({ ...mapLeadToRow(lead), tenant_id: tenantId }).select().single();
      if (!error) return { lead: mapRowToLead(data as LeadRow), deduped: false };
      if (error.code === "23505") {
        const existing = await db.from("leads").select("*").eq("tenant_id", tenantId).eq("source", lead.source!).eq("source_ref", lead.sourceRef!).maybeSingle();
        if (!existing.error && existing.data) return { lead: mapRowToLead(existing.data as LeadRow), deduped: true };
      }
      throw new Error("Intake write unavailable");
    },
    // Uses the governed contract and existing store, with a cookie-free client.
    emit: input => emitEvent(input, new SupabaseBusinessEventStore(async () => intakeClient())),
    async notify(tenant, lead) {
      if (!tenant.email) { console.warn("[intake] owner notification skipped: tenant email not configured", { leadId: lead.id }); return; }
      const outcome = await withTelemetryDeadline(sendEmail(tenant.email, "New service request in AI BackOffice", `A new ${lead.serviceType} request has arrived. Emergency: ${lead.emergency}. Open AI BackOffice Lead Inbox to review it. Lead reference: ${lead.id}.`));
      if (outcome.outcome !== "resolved" || !outcome.value.ok) throw new Error("Notification unavailable");
    },
  };
}
