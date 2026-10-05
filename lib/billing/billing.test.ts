import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { verifyStripeSignature } from "./stripe";
import { entitlementForStatus, type Entitlement } from "./entitlement";
import { processStripeEvent, type BillingStore, type ProvisionInput, type StripeEvent, type SubscriptionPatch } from "./webhook";

const SECRET = "whsec_test";
const sign = (body: string, t: number, secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

describe("verifyStripeSignature", () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;
  it("accepts a valid signature", () => expect(verifyStripeSignature(body, sign(body, now), SECRET, now)).toBe(true));
  it("rejects wrong secret, tampered body, missing header/secret", () => {
    expect(verifyStripeSignature(body, sign(body, now, "other"), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body + " ", sign(body, now), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, null, SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, sign(body, now), undefined, now)).toBe(false);
  });
  it("rejects replays outside the tolerance window and malformed headers", () => {
    expect(verifyStripeSignature(body, sign(body, now - 301), SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, "t=abc,v1=zz", SECRET, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${now},v1=deadbeef`, SECRET, now)).toBe(false);
  });
});

describe("entitlementForStatus", () => {
  it.each([
    ["active", "active"], ["trialing", "active"], ["past_due", "restricted"], ["unpaid", "restricted"],
    ["incomplete", "restricted"], ["paused", "restricted"], ["canceled", "revoked"], ["incomplete_expired", "revoked"], ["weird", "restricted"],
  ])("%s -> %s", (s, e) => expect(entitlementForStatus(s)).toBe(e));
});

type Row = { entitlement: Entitlement; subscription_status: string; onboarding: string; tenant: string; email: string; cancel?: boolean };
function fakeStore() {
  const events = new Map<string, "processing" | "processed" | "failed">();
  const subs = new Map<string, Row>();
  const tenants = new Set<string>();
  const store: BillingStore & { subs: typeof subs; tenants: typeof tenants; events: typeof events; failNextProvision: boolean } = {
    subs, tenants, events, failNextProvision: false,
    async claimEvent(id) {
      const s = events.get(id);
      if (s === "processed") return "duplicate";
      events.set(id, "processing");
      return s ? "retry" : "new";
    },
    async finishEvent(id, status) { events.set(id, status); },
    async provision(i: ProvisionInput) {
      if (this.failNextProvision) { this.failNextProvision = false; throw new Error("db down"); }
      if (subs.has(i.subscriptionId)) return;
      const tenant = `tenant-for-${i.subscriptionId}`;
      tenants.add(tenant);
      subs.set(i.subscriptionId, { entitlement: "active", subscription_status: i.subscriptionStatus, onboarding: "onboarding_required", tenant, email: i.email });
    },
    async updateSubscription(id, patch: SubscriptionPatch) {
      const r = subs.get(id); if (!r) return false;
      if (patch.entitlement) r.entitlement = patch.entitlement;
      if (patch.subscription_status) r.subscription_status = patch.subscription_status;
      if (patch.cancel_at_period_end !== undefined) r.cancel = patch.cancel_at_period_end;
      return true;
    },
    async getEntitlement(id) { return subs.get(id)?.entitlement ?? null; },
  };
  return store;
}

const checkout = (over: Record<string, any> = {}, id = "evt_checkout"): StripeEvent => ({
  id, type: "checkout.session.completed",
  data: { object: { mode: "subscription", payment_status: "paid", customer: "cus_1", subscription: "sub_1", metadata: { plan: "founder_beta_299" },
    customer_details: { email: "Owner@Acme.com" }, custom_fields: [{ key: "business_name", text: { value: "Acme Plumbing" } }], ...over } },
});
const subEvent = (type: string, status: string, id = "evt_s", over: Record<string, any> = {}): StripeEvent => ({
  id, type, data: { object: { id: "sub_1", status, metadata: { plan: "founder_beta_299" }, current_period_end: 1_900_000_000, cancel_at_period_end: false, ...over } },
});

describe("Founder Beta webhook lifecycle", () => {
  it("paid checkout provisions customer + onboarding_required + active entitlement (no admission gate)", async () => {
    const s = fakeStore();
    expect(await processStripeEvent(checkout(), s)).toMatchObject({ outcome: "processed" });
    expect(s.subs.get("sub_1")).toMatchObject({ entitlement: "active", onboarding: "onboarding_required", email: "owner@acme.com" });
  });
  it("unpaid checkout, wrong mode, or non-Founder-Beta plan never grants entitlement", async () => {
    const s = fakeStore();
    expect((await processStripeEvent(checkout({ payment_status: "unpaid" }, "e1"), s)).outcome).toBe("ignored");
    expect((await processStripeEvent(checkout({ mode: "payment" }, "e2"), s)).outcome).toBe("ignored");
    expect((await processStripeEvent(checkout({ metadata: {} }, "e3"), s)).outcome).toBe("ignored");
    expect(s.subs.size).toBe(0);
  });
  it("duplicate event delivery is a no-op", async () => {
    const s = fakeStore();
    await processStripeEvent(checkout(), s);
    expect((await processStripeEvent(checkout(), s)).outcome).toBe("duplicate");
    expect(s.subs.size).toBe(1); expect(s.tenants.size).toBe(1);
  });
  it("a failed attempt is marked failed, surfaces an error (HTTP 500), and the retry succeeds", async () => {
    const s = fakeStore(); s.failNextProvision = true;
    await expect(processStripeEvent(checkout(), s)).rejects.toThrow("db down");
    expect(s.events.get("evt_checkout")).toBe("failed");
    expect((await processStripeEvent(checkout(), s)).outcome).toBe("processed");
    expect(s.subs.size).toBe(1);
  });
  it("failed payment restricts; later successful payment restores", async () => {
    const s = fakeStore(); await processStripeEvent(checkout(), s);
    await processStripeEvent({ id: "i1", type: "invoice.payment_failed", data: { object: { subscription: "sub_1" } } }, s);
    expect(s.subs.get("sub_1")).toMatchObject({ entitlement: "restricted", subscription_status: "past_due" });
    await processStripeEvent({ id: "i2", type: "invoice.paid", data: { object: { subscription: "sub_1" } } }, s);
    expect(s.subs.get("sub_1")!.entitlement).toBe("active");
  });
  it("cancellation revokes and a late invoice.paid cannot resurrect it", async () => {
    const s = fakeStore(); await processStripeEvent(checkout(), s);
    await processStripeEvent(subEvent("customer.subscription.deleted", "canceled", "d1"), s);
    expect(s.subs.get("sub_1")!.entitlement).toBe("revoked");
    expect((await processStripeEvent({ id: "i3", type: "invoice.paid", data: { object: { subscription: "sub_1" } } }, s)).detail).toBe("revoked-stays-revoked");
    expect(s.subs.get("sub_1")!.entitlement).toBe("revoked");
  });
  it("cancel-at-period-end keeps access until the subscription actually ends", async () => {
    const s = fakeStore(); await processStripeEvent(checkout(), s);
    await processStripeEvent(subEvent("customer.subscription.updated", "active", "u1", { cancel_at_period_end: true }), s);
    expect(s.subs.get("sub_1")).toMatchObject({ entitlement: "active", cancel: true });
  });
  it("subscription event before provisioning throws so Stripe retries; unrelated plans are ignored", async () => {
    const s = fakeStore();
    await expect(processStripeEvent(subEvent("customer.subscription.updated", "active", "early"), s)).rejects.toThrow("not provisioned yet");
    expect((await processStripeEvent(subEvent("customer.subscription.updated", "active", "other", { metadata: { plan: "x" } }), s)).outcome).toBe("ignored");
  });
  it("invoice events for unknown subscriptions are ignored (other Stripe products)", async () => {
    const s = fakeStore();
    expect((await processStripeEvent({ id: "z", type: "invoice.payment_failed", data: { object: { subscription: "sub_other" } } }, s)).outcome).toBe("ignored");
  });
});
