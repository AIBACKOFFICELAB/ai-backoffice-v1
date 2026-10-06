import "server-only";
import { billingAdminClient } from "./admin";
import type { BillingStore, ProvisionInput, SubscriptionPatch } from "./webhook";
import type { Entitlement } from "./entitlement";
import { provisionFounderBeta, tenantSlugForSubscription, type ProvisioningOps } from "./provisioning";

type Admin = ReturnType<typeof billingAdminClient>;

async function findUserIdByEmail(db: Admin, email: string): Promise<string | null> {
  // Beta-scale lookup (small user base); paginates defensively.
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error("user lookup failed");
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}


export { tenantSlugForSubscription };

function supabaseProvisioningOps(db: Admin): ProvisioningOps {
  return {
    async findBillingTenantBySubscription(subscriptionId) {
      const { data, error } = await db.from("billing_subscriptions").select("tenant_id").eq("stripe_subscription_id", subscriptionId).maybeSingle();
      if (error) throw new Error("billing lookup failed");
      return data?.tenant_id ?? null;
    },
    async findOrCreateUser(email) {
      // No password: the buyer sets one via the existing password-recovery flow.
      const found = await findUserIdByEmail(db, email);
      if (found) return found;
      const created = await db.auth.admin.createUser({ email, email_confirm: true });
      if (!created.error && created.data.user) return created.data.user.id;
      const raced = await findUserIdByEmail(db, email);
      if (!raced) throw new Error("user creation failed");
      return raced;
    },
    async findTenantIdBySlug(slug) {
      const { data, error } = await db.from("tenants").select("id").eq("slug", slug).maybeSingle();
      if (error) throw new Error("tenant lookup failed");
      return data?.id ?? null;
    },
    async createTenant(t) {
      const { data, error } = await db.from("tenants").insert({ name: t.name, slug: t.slug, email: t.email, status: "active" }).select("id").single();
      if (error || !data) throw new Error("tenant creation failed");
      return data.id;
    },
    async listMemberships(userId) {
      const { data, error } = await db.from("tenant_memberships").select("tenant_id, role").eq("user_id", userId);
      if (error) throw new Error("membership lookup failed");
      return (data ?? []).map((m) => ({ tenantId: m.tenant_id, role: m.role }));
    },
    async listBilling(tenantId) {
      const { data, error } = await db.from("billing_subscriptions").select("plan, entitlement").eq("tenant_id", tenantId);
      if (error) throw new Error("billing lookup failed");
      return (data ?? []) as Array<{ plan: string; entitlement: Entitlement }>;
    },
    async replaceRevokedBilling(tenantId, input) {
      // Onboarding state is preserved as recorded (never invented as complete).
      const { data, error } = await db
        .from("billing_subscriptions")
        .update({
          stripe_customer_id: input.customerId,
          stripe_subscription_id: input.subscriptionId,
          purchaser_email: input.email,
          subscription_status: input.subscriptionStatus,
          entitlement: input.entitlement,
          current_period_end: input.currentPeriodEnd,
          cancel_at_period_end: false,
          canceled_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("plan", "founder_beta_299")
        .eq("entitlement", "revoked") // guard: never overwrite a live/restricted relationship
        .select("id");
      if (error) throw new Error("billing record replacement failed");
      return (data ?? []).length;
    },
    async insertBilling(tenantId, input) {
      const { error } = await db.from("billing_subscriptions").upsert(
        {
          tenant_id: tenantId,
          plan: "founder_beta_299",
          stripe_customer_id: input.customerId,
          stripe_subscription_id: input.subscriptionId,
          purchaser_email: input.email,
          subscription_status: input.subscriptionStatus,
          entitlement: input.entitlement,
          onboarding_status: "onboarding_required",
          current_period_end: input.currentPeriodEnd,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "stripe_subscription_id", ignoreDuplicates: true }
      );
      if (error) throw new Error("billing record creation failed");
    },
    async ensureOwnerMembership(tenantId, userId) {
      const { error } = await db
        .from("tenant_memberships")
        .upsert({ tenant_id: tenantId, user_id: userId, role: "owner" }, { onConflict: "tenant_id,user_id", ignoreDuplicates: true });
      if (error) throw new Error("membership creation failed");
    },
  };
}

export function createSupabaseBillingStore(): BillingStore {
  const db = billingAdminClient();

  return {
    async claimEvent(eventId, eventType) {
      const ins = await db.from("stripe_webhook_events").insert({ event_id: eventId, event_type: eventType });
      if (!ins.error) return "new";
      if (ins.error.code !== "23505") throw new Error("webhook ledger unavailable");
      const { data, error } = await db.from("stripe_webhook_events").select("status").eq("event_id", eventId).maybeSingle();
      if (error || !data) throw new Error("webhook ledger unavailable");
      if (data.status === "processed") return "duplicate";
      // Keep the prior failure text: a retry must not erase reconciliation evidence.
      await db.from("stripe_webhook_events").update({ status: "processing" }).eq("event_id", eventId);
      return "retry";
    },

    async finishEvent(eventId, status, error) {
      // On success the last failure text (if any) is retained as history; on failure it is replaced by the newest bounded code.
      const patch: Record<string, unknown> = { status, processed_at: new Date().toISOString() };
      if (status === "failed") patch.error = error ?? "PROCESSING_FAILED";
      await db.from("stripe_webhook_events").update(patch).eq("event_id", eventId);
    },

    async provision(input: ProvisionInput) {
      await provisionFounderBeta(supabaseProvisioningOps(db), input);
    },

    async updateSubscription(subscriptionId: string, patch: SubscriptionPatch) {
      const { data, error } = await db
        .from("billing_subscriptions")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("stripe_subscription_id", subscriptionId)
        .select("id");
      if (error) throw new Error("billing update failed");
      return (data ?? []).length > 0;
    },

    async getEntitlement(subscriptionId: string): Promise<Entitlement | null> {
      const { data, error } = await db.from("billing_subscriptions").select("entitlement").eq("stripe_subscription_id", subscriptionId).maybeSingle();
      if (error) throw new Error("billing lookup failed");
      return (data?.entitlement as Entitlement) ?? null;
    },
  };
}
