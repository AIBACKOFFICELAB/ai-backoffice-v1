import "server-only";
import { createClient } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenant";
import { emitEvent } from "@/lib/events/service";
import { SupabaseBusinessEventStore } from "@/lib/events/store";
import type { MarkEstimateSentDeps } from "./estimateLifecycle";

// Private, cookie-free client: only the validated estimate.sent operation is exported.
// Do not change the shared SSR client or allow authenticated arbitrary event writes.
function eventClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Estimate event database unavailable");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(8000) }) },
  });
}

export const emitEstimateSentEvent: MarkEstimateSentDeps["emitLifecycleEvent"] = async (input) => {
  const tenant = await getTenantContext();
  if (!tenant || tenant.tenantId !== input.tenantId || tenant.userId !== input.actorUserId) {
    throw new Error("Estimate event tenant authorization failed");
  }
  // Verify both facts through the caller's tenant-scoped/RLS client before elevation.
  const db = await createServerSupabaseClient();
  const lead = await db.from("leads").select("id,status,estimate_amount")
    .eq("tenant_id", tenant.tenantId).eq("id", input.leadId).maybeSingle();
  const sequence = await db.from("estimate_followup_sequences").select("id")
    .eq("tenant_id", tenant.tenantId).eq("lead_id", input.leadId).maybeSingle();
  if (lead.error || sequence.error || !sequence.data || !lead.data ||
      lead.data.status !== "Estimate Sent" || !Number.isFinite(Number(lead.data.estimate_amount)) || Number(lead.data.estimate_amount) <= 0) {
    throw new Error("Estimate event lifecycle facts unavailable");
  }
  await emitEvent({
    tenantId: tenant.tenantId, eventType: "estimate.sent", actorType: "user",
    actorId: tenant.userId, entityType: "lead", entityId: input.leadId,
    idempotencyKey: `estimate.sent:${input.leadId}`,
    payload: { estimateAmount: Number(lead.data.estimate_amount), sequenceCreated: input.sequenceCreated },
  }, new SupabaseBusinessEventStore(async () => eventClient()));
};
