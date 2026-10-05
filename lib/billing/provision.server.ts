import "server-only";
import { billingAdminClient } from "./admin";
import type { BillingStore, ProvisionInput, SubscriptionPatch } from "./webhook";
import type { Entitlement } from "./entitlement";

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

/** Deterministic per subscription -> retries find-or-create the same tenant. */
export function tenantSlugForSubscription(subscriptionId: string): string {
  return `beta-${subscriptionId.replace(/[^a-z0-9]/gi, "").slice(-12).toLowerCase()}`;
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
      await db.from("stripe_webhook_events").update({ status: "processing", error: null }).eq("event_id", eventId);
      return "retry";
    },

    async finishEvent(eventId, status, error) {
      await db
        .from("stripe_webhook_events")
        .update({ status, error: error ?? null, processed_at: new Date().toISOString() })
        .eq("event_id", eventId);
    },

    async provision(input: ProvisionInput) {
      const existing = await db.from("billing_subscriptions").select("id").eq("stripe_subscription_id", input.subscriptionId).maybeSingle();
      if (existing.error) throw new Error("billing lookup failed");
      if (existing.data) return; // already provisioned (duplicate/retry)

      // 1. user (no password; buyer sets one via the existing password-recovery flow)
      let userId = await findUserIdByEmail(db, input.email);
      if (!userId) {
        const created = await db.auth.admin.createUser({ email: input.email, email_confirm: true });
        if (created.error || !created.data.user) {
          userId = await findUserIdByEmail(db, input.email); // race with a retry
          if (!userId) throw new Error("user creation failed");
        } else {
          userId = created.data.user.id;
        }
      }

      // 2. tenant (deterministic slug -> idempotent)
      const slug = tenantSlugForSubscription(input.subscriptionId);
      let tenantId: string | null = null;
      const t = await db.from("tenants").select("id").eq("slug", slug).maybeSingle();
      if (t.error) throw new Error("tenant lookup failed");
      if (t.data) {
        tenantId = t.data.id;
      } else {
        const ct = await db
          .from("tenants")
          .insert({ name: input.businessName, slug, email: input.email, status: "active" })
          .select("id")
          .single();
        if (ct.error || !ct.data) throw new Error("tenant creation failed");
        tenantId = ct.data.id;
      }

      // 3. owner membership — refuse to wire a user already attached to ANOTHER tenant
      const other = await db.from("tenant_memberships").select("tenant_id").eq("user_id", userId);
      if (other.error) throw new Error("membership lookup failed");
      if ((other.data ?? []).some((m) => m.tenant_id !== tenantId)) {
        throw new Error("purchaser already belongs to another tenant; Founder reconciliation required");
      }
      const mem = await db
        .from("tenant_memberships")
        .upsert({ tenant_id: tenantId, user_id: userId, role: "owner" }, { onConflict: "tenant_id,user_id" });
      if (mem.error) throw new Error("membership creation failed");

      // 4. billing record: PAID — ONBOARDING REQUIRED
      const bill = await db.from("billing_subscriptions").upsert(
        {
          tenant_id: tenantId,
          plan: "founder_beta_299",
          stripe_customer_id: input.customerId,
          stripe_subscription_id: input.subscriptionId,
          purchaser_email: input.email,
          subscription_status: input.subscriptionStatus,
          entitlement: "active",
          onboarding_status: "onboarding_required",
          current_period_end: input.currentPeriodEnd,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "stripe_subscription_id" }
      );
      if (bill.error) throw new Error("billing record creation failed");
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
