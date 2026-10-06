import { describe, expect, it } from "vitest";
import type { Entitlement } from "./entitlement";
import { processStripeEvent as run, sanitizeLedgerError, type BillingStore, type ProvisionInput, type StripeEvent, type SubscriptionFetcher } from "./webhook";
import { decideTenantForPurchaser, ReconciliationRequiredError } from "./tenantResolution";
import { provisionFounderBeta, type ProvisioningOps } from "./provisioning";

/**
 * PR #31 Codex P1 remediation:
 *  P1-1 delayed (async) Checkout payment success
 *  P1-2 safe repeat purchase / re-subscription
 * The fake below mirrors lib/billing/provision.server.ts step-for-step
 * (same pure decideTenantForPurchaser policy, same deterministic slug, same
 * ledger retention semantics) so the webhook path is exercised end to end.
 */

type BillingRow = { tenantId: string; plan: string; subscriptionId: string; customerId: string; entitlement: Entitlement; status: string; onboarding: string };
type Ledger = { status: "processing" | "processed" | "failed"; error: string | null };

function world() {
  const users = new Map<string, string>(); // email -> userId
  const tenants = new Map<string, string>(); // tenantId -> slug
  const memberships: Array<{ userId: string; tenantId: string; role: string }> = [];
  const billing: BillingRow[] = [];
  const ledger = new Map<string, Ledger>();
  let n = 0;

  const faults = { billing: 0, membership: 0 }; // number of upcoming writes to fail
  const ops: ProvisioningOps = {
    async findBillingTenantBySubscription(sub) { return billing.find((b) => b.subscriptionId === sub)?.tenantId ?? null; },
    async findOrCreateUser(email) { let u = users.get(email); if (!u) { u = `u${++n}`; users.set(email, u); } return u; },
    async findTenantIdBySlug(slug) { return Array.from(tenants).find(([, s]) => s === slug)?.[0] ?? null; },
    async createTenant(t) { const id = `t${++n}`; tenants.set(id, t.slug); return id; },
    async listMemberships(userId) { return memberships.filter((m) => m.userId === userId).map((m) => ({ tenantId: m.tenantId, role: m.role })); },
    async listBilling(tenantId) { return billing.filter((b) => b.tenantId === tenantId).map((b) => ({ plan: b.plan, entitlement: b.entitlement })); },
    async replaceRevokedBilling(tenantId, i) {
      const rows = billing.filter((b) => b.tenantId === tenantId && b.plan === "founder_beta_299" && b.entitlement === "revoked");
      rows.forEach((r) => Object.assign(r, { subscriptionId: i.subscriptionId, customerId: i.customerId, entitlement: i.entitlement, status: i.subscriptionStatus }));
      return rows.length;
    },
    async insertBilling(tenantId, i) {
      if (faults.billing > 0) { faults.billing--; throw new Error("billing record creation failed"); }
      if (billing.some((b) => b.subscriptionId === i.subscriptionId)) return; // ON CONFLICT DO NOTHING
      if (billing.some((b) => b.tenantId === tenantId)) throw new Error("billing record creation failed"); // UNIQUE(tenant_id)
      billing.push({ tenantId, plan: "founder_beta_299", subscriptionId: i.subscriptionId, customerId: i.customerId, entitlement: i.entitlement, status: i.subscriptionStatus, onboarding: "onboarding_required" });
    },
    async ensureOwnerMembership(tenantId, userId) {
      if (faults.membership > 0) { faults.membership--; throw new Error("membership creation failed"); }
      if (!memberships.some((m) => m.userId === userId && m.tenantId === tenantId)) memberships.push({ userId, tenantId, role: "owner" });
    },
  };

  const store: BillingStore = {
    async claimEvent(id) {
      const l = ledger.get(id);
      if (l?.status === "processed") return "duplicate";
      if (l) { l.status = "processing"; return "retry"; } // prior error text retained
      ledger.set(id, { status: "processing", error: null });
      return "new";
    },
    async finishEvent(id, status, error) {
      const l = ledger.get(id)!;
      l.status = status;
      if (status === "failed") l.error = error ?? "PROCESSING_FAILED";
    },
    async provision(i: ProvisionInput) {
      await provisionFounderBeta(ops, i);
    },
    async updateSubscription(sub, patch) {
      const b = billing.find((x) => x.subscriptionId === sub);
      if (!b) return false;
      if (patch.entitlement) b.entitlement = patch.entitlement;
      if (patch.subscription_status) b.status = patch.subscription_status;
      return true;
    },
    async getEntitlement(sub) { return billing.find((b) => b.subscriptionId === sub)?.entitlement ?? null; },
  };

  const stripeState = new Map<string, string>(); // subscriptionId -> current status
  const fetchSub: SubscriptionFetcher = async (id) => ({ id, status: stripeState.get(id) ?? "active", metadata: { plan: "founder_beta_299" } });
  return { store, ops, faults, fetchSub, stripeState, users, tenants, memberships, billing, ledger, seedTenant(id: string) { tenants.set(id, `internal-${id}`); } };
}

const session = (type: string, over: Record<string, any> = {}, id = `evt_${type}`): StripeEvent => ({
  id, type,
  data: { object: { mode: "subscription", payment_status: "paid", customer: "cus_1", subscription: "sub_1", metadata: { plan: "founder_beta_299" }, customer_details: { email: "owner@acme.com" }, ...over } },
});

describe("P1-1 delayed Checkout payment", () => {
  it("1. ordinary paid checkout.session.completed provisions exactly once", async () => {
    const w = world();
    expect(await run(session("checkout.session.completed"), w.store, w.fetchSub)).toMatchObject({ outcome: "processed", detail: "provisioned" });
    expect(await run(session("checkout.session.completed", {}, "evt_again"), w.store, w.fetchSub)).toMatchObject({ outcome: "processed" });
    expect(w.billing).toHaveLength(1);
    expect(w.tenants.size).toBe(1);
  });
  it("2. unpaid checkout.session.completed does not provision; recorded as awaiting async payment", async () => {
    const w = world();
    expect(await run(session("checkout.session.completed", { payment_status: "unpaid" }), w.store, w.fetchSub)).toMatchObject({ outcome: "processed", detail: "awaiting-async-payment" });
    expect(w.billing).toHaveLength(0);
    expect(w.tenants.size).toBe(0);
    expect(w.users.size).toBe(0);
  });
  it("3. later async_payment_succeeded provisions exactly once through the same path", async () => {
    const w = world();
    await run(session("checkout.session.completed", { payment_status: "unpaid" }), w.store, w.fetchSub);
    expect(await run(session("checkout.session.async_payment_succeeded"), w.store, w.fetchSub)).toMatchObject({ detail: "provisioned" });
    expect(w.billing).toHaveLength(1);
    expect(w.billing[0]).toMatchObject({ entitlement: "active", onboarding: "onboarding_required" });
  });
  it("4. async_payment_failed does not provision (no tenant, no billing)", async () => {
    const w = world();
    await run(session("checkout.session.completed", { payment_status: "unpaid" }), w.store, w.fetchSub);
    expect(await run(session("checkout.session.async_payment_failed", { payment_status: "unpaid" }), w.store, w.fetchSub)).toMatchObject({ outcome: "processed", detail: "async-payment-failed-no-entitlement" });
    expect(w.billing).toHaveLength(0);
    expect(w.tenants.size).toBe(0);
  });
  it("5. replayed async success is idempotent (duplicate event id and new event id)", async () => {
    const w = world();
    await run(session("checkout.session.async_payment_succeeded"), w.store, w.fetchSub);
    expect((await run(session("checkout.session.async_payment_succeeded"), w.store, w.fetchSub)).outcome).toBe("duplicate");
    await run(session("checkout.session.async_payment_succeeded", {}, "evt_redelivered_new_id"), w.store, w.fetchSub);
    expect(w.billing).toHaveLength(1);
    expect(w.tenants.size).toBe(1);
  });
  it.each([
    ["missing email", { customer_details: {}, customer_email: undefined }],
    ["malformed email", { customer_details: { email: "not-an-email" } }],
    ["missing customer", { customer: null }],
    ["missing subscription", { subscription: "" }],
  ])("6. %s fails safely with a bounded ledger code and no provisioning", async (_l, over) => {
    for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded"]) {
      const w = world();
      await expect(run(session(type, over, `e-${type}`), w.store, w.fetchSub)).rejects.toThrow("INVALID_CHECKOUT");
      expect(w.ledger.get(`e-${type}`)).toEqual({ status: "failed", error: "INVALID_CHECKOUT:missing_email_customer_or_subscription" });
      expect(w.billing).toHaveLength(0);
    }
  });
  it("7. entitlement comes from the authoritative Stripe re-read, not the event", async () => {
    const w = world();
    w.stripeState.set("sub_1", "past_due"); // money cleared then a later charge failed before we processed
    await run(session("checkout.session.async_payment_succeeded"), w.store, w.fetchSub);
    expect(w.billing[0]).toMatchObject({ entitlement: "restricted", status: "past_due" });
  });
  it("non-Founder-Beta async events are ignored", async () => {
    const w = world();
    expect((await run(session("checkout.session.async_payment_succeeded", { metadata: {} }), w.store, w.fetchSub)).outcome).toBe("ignored");
    expect((await run(session("checkout.session.async_payment_succeeded", { mode: "payment" }, "e2"), w.store, w.fetchSub)).outcome).toBe("ignored");
    expect(w.billing).toHaveLength(0);
  });
});

describe("P1-2 safe repeat purchase / re-subscription", () => {
  async function endedCustomer() {
    const w = world();
    await run(session("checkout.session.completed"), w.store, w.fetchSub);
    w.stripeState.set("sub_1", "canceled");
    await run({ id: "del", type: "customer.subscription.deleted", data: { object: { id: "sub_1", status: "canceled", metadata: { plan: "founder_beta_299" } } } }, w.store, w.fetchSub);
    expect(w.billing[0].entitlement).toBe("revoked");
    return w;
  }
  const resub = (id = "evt_resub") => session("checkout.session.completed", { customer: "cus_2", subscription: "sub_2" }, id);

  it("1+2. revoked Founder Beta owner re-subscribes into the SAME tenant; new subscription replaces the old association", async () => {
    const w = await endedCustomer();
    const originalTenant = w.billing[0].tenantId;
    expect(await run(resub(), w.store, w.fetchSub)).toMatchObject({ outcome: "processed", detail: "provisioned" });
    expect(w.tenants.size).toBe(1);
    expect(w.billing).toHaveLength(1);
    expect(w.billing[0]).toMatchObject({ tenantId: originalTenant, subscriptionId: "sub_2", customerId: "cus_2", entitlement: "active", status: "active" });
    expect(await w.store.getEntitlement("sub_1")).toBeNull(); // old association gone
  });
  it("re-subscription preserves recorded onboarding state (never invents completion)", async () => {
    const w = await endedCustomer();
    w.billing[0].onboarding = "complete";
    await run(resub(), w.store, w.fetchSub);
    expect(w.billing[0].onboarding).toBe("complete");
    const w2 = await endedCustomer();
    await run(resub(), w2.store, w2.fetchSub);
    expect(w2.billing[0].onboarding).toBe("onboarding_required");
  });
  it("3. retry of the same new subscription is idempotent", async () => {
    const w = await endedCustomer();
    await run(resub("a"), w.store, w.fetchSub);
    await run(resub("b"), w.store, w.fetchSub);
    expect((await run(resub("a"), w.store, w.fetchSub)).outcome).toBe("duplicate");
    expect(w.billing).toHaveLength(1);
    expect(w.tenants.size).toBe(1);
  });
  it.each([
    ["active", "prior_entitlement_active"],
    ["restricted", "prior_entitlement_restricted"],
  ] as const)("4/5. %s prior Founder Beta subscription requires Founder reconciliation (no overwrite)", async (ent, reason) => {
    const w = world();
    await run(session("checkout.session.completed"), w.store, w.fetchSub);
    w.billing[0].entitlement = ent;
    await expect(run(resub(), w.store, w.fetchSub)).rejects.toThrow(`RECONCILIATION_REQUIRED:${reason}`);
    expect(w.billing).toHaveLength(1);
    expect(w.billing[0].subscriptionId).toBe("sub_1");
    expect(w.tenants.size).toBe(1);
  });
  it("6. multiple memberships require Founder reconciliation", async () => {
    const w = await endedCustomer();
    w.seedTenant("tX");
    w.memberships.push({ userId: w.users.get("owner@acme.com")!, tenantId: "tX", role: "owner" });
    await expect(run(resub(), w.store, w.fetchSub)).rejects.toThrow("RECONCILIATION_REQUIRED:multiple_memberships");
  });
  it("7. staff-only membership requires Founder reconciliation", async () => {
    const w = await endedCustomer();
    w.memberships[0].role = "staff";
    await expect(run(resub(), w.store, w.fetchSub)).rejects.toThrow("RECONCILIATION_REQUIRED:non_owner_membership");
  });
  it("8. existing internal tenant with no Founder Beta billing requires Founder reconciliation", async () => {
    const w = world();
    w.seedTenant("internal");
    w.users.set("owner@acme.com", "uI");
    w.memberships.push({ userId: "uI", tenantId: "internal", role: "owner" });
    await expect(run(session("checkout.session.completed"), w.store, w.fetchSub)).rejects.toThrow("RECONCILIATION_REQUIRED:no_prior_founder_beta_billing");
    expect(w.billing).toHaveLength(0);
    expect(w.tenants.size).toBe(1);
  });
  it("8b. prior billing row that is not Founder Beta requires reconciliation", () => {
    expect(() => decideTenantForPurchaser([{ tenantId: "t", role: "owner", isThisSubscriptionTenant: false, billing: [{ plan: "other", entitlement: "revoked" }] }])).toThrow("prior_billing_not_founder_beta");
    expect(() => decideTenantForPurchaser([{ tenantId: "t", role: "owner", isThisSubscriptionTenant: false, billing: [{ plan: "founder_beta_299", entitlement: "revoked" }, { plan: "founder_beta_299", entitlement: "revoked" }] }])).toThrow("multiple_billing_rows");
  });
  it("9. no prior membership provisions through the ordinary new-customer path", async () => {
    const w = world();
    await run(session("checkout.session.completed"), w.store, w.fetchSub);
    expect(w.memberships).toHaveLength(1);
    expect(w.billing[0]).toMatchObject({ subscriptionId: "sub_1", onboarding: "onboarding_required" });
  });
  it("partial new-customer provisioning (membership created, billing failed) resumes on retry instead of demanding reconciliation", () => {
    expect(decideTenantForPurchaser([{ tenantId: "slugT", role: "owner", isThisSubscriptionTenant: true, billing: [] }])).toEqual({ kind: "continue", tenantId: "slugT" });
  });
  it("10. reconciliation failure is durably recorded in the webhook ledger and NOT erased by retries", async () => {
    const w = world();
    await run(session("checkout.session.completed"), w.store, w.fetchSub);
    w.billing[0].entitlement = "active";
    await expect(run(resub("evt_dup_purchase"), w.store, w.fetchSub)).rejects.toThrow();
    expect(w.ledger.get("evt_dup_purchase")).toEqual({ status: "failed", error: "RECONCILIATION_REQUIRED:prior_entitlement_active" });
    await expect(run(resub("evt_dup_purchase"), w.store, w.fetchSub)).rejects.toThrow(); // Stripe retry
    expect(w.ledger.get("evt_dup_purchase")).toEqual({ status: "failed", error: "RECONCILIATION_REQUIRED:prior_entitlement_active" });
  });
});

describe("P1-3 billing before membership (fail-closed provisioning order)", () => {
  const paid = (id = "evt_paid") => session("checkout.session.completed", {}, id);
  it("1. billing failure leaves NO owner membership and the event fails retryably", async () => {
    const w = world(); w.faults.billing = 1;
    await expect(run(paid(), w.store, w.fetchSub)).rejects.toThrow();
    expect(w.memberships).toHaveLength(0);
    expect(w.billing).toHaveLength(0);
    expect(w.ledger.get("evt_paid")).toEqual({ status: "failed", error: "PROVISIONING:billing_record_creation_failed" });
  });
  it("2+3. billing ok + membership fails -> durable billing, no access; retry repairs membership", async () => {
    const w = world(); w.faults.membership = 1;
    await expect(run(paid(), w.store, w.fetchSub)).rejects.toThrow("membership creation failed");
    expect(w.billing).toHaveLength(1);
    expect(w.memberships).toHaveLength(0);
    await run(paid(), w.store, w.fetchSub); // Stripe retry
    expect(w.memberships).toEqual([{ userId: w.users.get("owner@acme.com"), tenantId: w.billing[0].tenantId, role: "owner" }]);
    expect(w.billing).toHaveLength(1);
    expect(w.billing[0].entitlement).toBe("active");
  });
  it("4+6+7+8. retries after complete success are idempotent (no duplicate tenant/billing/membership)", async () => {
    const w = world();
    await run(paid("a"), w.store, w.fetchSub);
    await run(paid("b"), w.store, w.fetchSub);
    await run(session("checkout.session.async_payment_succeeded", {}, "c"), w.store, w.fetchSub);
    expect(w.tenants.size).toBe(1);
    expect(w.billing).toHaveLength(1);
    expect(w.memberships).toHaveLength(1);
  });
  it("5. existing exact-subscription billing with missing membership is repaired directly", async () => {
    const w = world();
    await run(paid(), w.store, w.fetchSub);
    w.memberships.length = 0;
    await provisionFounderBeta(w.ops, { email: "owner@acme.com", businessName: "x", customerId: "cus_1", subscriptionId: "sub_1", subscriptionStatus: "active", entitlement: "active", currentPeriodEnd: null });
    expect(w.memberships).toHaveLength(1);
  });
  it("existing-subscription repair never alters an existing membership role or entitlement", async () => {
    const w = world();
    await run(paid(), w.store, w.fetchSub);
    w.billing[0].entitlement = "restricted";
    await provisionFounderBeta(w.ops, { email: "owner@acme.com", businessName: "x", customerId: "cus_1", subscriptionId: "sub_1", subscriptionStatus: "active", entitlement: "active", currentPeriodEnd: null });
    expect(w.billing[0].entitlement).toBe("restricted");
    expect(w.memberships).toHaveLength(1);
  });
  it("tenant created + billing failed: retry reuses the same deterministic tenant (no duplicate)", async () => {
    const w = world(); w.faults.billing = 2;
    await expect(run(paid(), w.store, w.fetchSub)).rejects.toThrow();
    await expect(run(paid(), w.store, w.fetchSub)).rejects.toThrow();
    await run(paid(), w.store, w.fetchSub);
    expect(w.tenants.size).toBe(1);
    expect(w.billing).toHaveLength(1);
    expect(w.memberships).toHaveLength(1);
  });
});

describe("ledger error sanitization", () => {
  it("passes bounded codes, maps known internal failures, and hides anything else", () => {
    expect(sanitizeLedgerError(new ReconciliationRequiredError("multiple_memberships"))).toBe("RECONCILIATION_REQUIRED:multiple_memberships");
    expect(sanitizeLedgerError(new Error("tenant creation failed"))).toBe("PROVISIONING:tenant_creation_failed");
    expect(sanitizeLedgerError(new Error("subscription sub_123 not provisioned yet"))).toBe("OUT_OF_ORDER:subscription_not_provisioned");
    expect(sanitizeLedgerError(new Error('duplicate key value violates unique constraint "x" email=owner@acme.com'))).toBe("PROCESSING_FAILED");
    expect(sanitizeLedgerError("weird")).toBe("PROCESSING_FAILED");
  });
});
