import "server-only";
import { billingAdminClient } from "./admin";
import type { BillingStore, ProvisionInput, SubscriptionPatch } from "./webhook";
import type { Entitlement } from "./entitlement";
import { decideTenantForPurchaser, type MembershipFact } from "./tenantResolution";

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

      // 2. which tenant? (pure policy: lib/billing/tenantResolution.ts)
      const slug = tenantSlugForSubscription(input.subscriptionId);
      const t = await db.from("tenants").select("id").eq("slug", slug).maybeSingle();
      if (t.error) throw new Error("tenant lookup failed");
      const slugTenantId: string | null = t.data?.id ?? null;

      const mems = await db.from("tenant_memberships").select("tenant_id, role").eq("user_id", userId);
      if (mems.error) throw new Error("membership lookup failed");
      const facts: MembershipFact[] = [];
      for (const m of mems.data ?? []) {
        const bills = await db.from("billing_subscriptions").select("plan, entitlement").eq("tenant_id", m.tenant_id);
        if (bills.error) throw new Error("billing lookup failed");
        facts.push({ tenantId: m.tenant_id, role: m.role, isThisSubscriptionTenant: m.tenant_id === slugTenantId, billing: (bills.data ?? []) as MembershipFact["billing"] });
      }
      const decision = decideTenantForPurchaser(facts); // throws ReconciliationRequiredError when ambiguous

      const now = new Date().toISOString();
      if (decision.kind === "reuse") {
        // 3a. Ended Founder Beta customer re-subscribing: SAME tenant, replace its single billing row.
        // Onboarding state is preserved as recorded (never invented as complete).
        const upd = await db
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
            updated_at: now,
          })
          .eq("tenant_id", decision.tenantId)
          .eq("plan", "founder_beta_299")
          .eq("entitlement", "revoked") // guard: never overwrite a live/restricted relationship
          .select("id");
        if (upd.error || (upd.data ?? []).length !== 1) throw new Error("billing record replacement failed");
        return;
      }

      // 3b. new customer (or retry of this subscription's own partial provisioning)
      let tenantId = decision.kind === "continue" ? decision.tenantId : slugTenantId;
      if (!tenantId) {
        const ct = await db.from("tenants").insert({ name: input.businessName, slug, email: input.email, status: "active" }).select("id").single();
        if (ct.error || !ct.data) throw new Error("tenant creation failed");
        tenantId = ct.data.id;
      }
      const mem = await db.from("tenant_memberships").upsert({ tenant_id: tenantId, user_id: userId, role: "owner" }, { onConflict: "tenant_id,user_id" });
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
          entitlement: input.entitlement,
          onboarding_status: "onboarding_required",
          current_period_end: input.currentPeriodEnd,
          updated_at: now,
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
