import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { getPgTestUrl, getPgTestPool, setRole, withRollback } from "../testHarness/pgTestDb";
import { provisionFounderBeta, type ProvisioningOps } from "./provisioning";
import type { ProvisionInput } from "./webhook";

/**
 * PR #31 P1-3 — provisioning ORDER against real Postgres constraints
 * (migration 025's UNIQUE(tenant_id)/UNIQUE(stripe_subscription_id), real
 * tenant_memberships uniqueness, real RLS). SQL mirrors the Supabase
 * adapter's upsert semantics (ON CONFLICT DO NOTHING). Each test runs in one
 * rolled-back transaction; injected faults use SAVEPOINTs so a failed write
 * behaves exactly like a failed separate request.
 */
const DESCRIBE = getPgTestUrl() ? describe : describe.skip;
afterAll(async () => { if (getPgTestUrl()) await getPgTestPool().end(); });

type C = import("pg").PoolClient;

function pgOps(c: C, faults: { billing: number; membership: number }): ProvisioningOps {
  const guarded = async <T>(kind: "billing" | "membership", fn: () => Promise<T>) => {
    await c.query("SAVEPOINT op");
    try {
      if (faults[kind] > 0) { faults[kind]--; await c.query("SELECT 1/0"); } // real DB error
      const r = await fn();
      await c.query("RELEASE SAVEPOINT op");
      return r;
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT op");
      throw new Error(kind === "billing" ? "billing record creation failed" : "membership creation failed");
    }
  };
  return {
    async findBillingTenantBySubscription(sub) { return (await c.query(`SELECT tenant_id FROM billing_subscriptions WHERE stripe_subscription_id=$1`, [sub])).rows[0]?.tenant_id ?? null; },
    async findOrCreateUser(email) {
      const f = await c.query(`SELECT id FROM auth.users WHERE email=$1`, [email]);
      if (f.rows[0]) return f.rows[0].id;
      return (await c.query(`INSERT INTO auth.users (id, email) VALUES ($1,$2) RETURNING id`, [randomUUID(), email])).rows[0].id;
    },
    async findTenantIdBySlug(slug) { return (await c.query(`SELECT id FROM tenants WHERE slug=$1`, [slug])).rows[0]?.id ?? null; },
    async createTenant(t) { return (await c.query(`INSERT INTO tenants (name, slug, email) VALUES ($1,$2,$3) RETURNING id`, [t.name, t.slug, t.email])).rows[0].id; },
    async listMemberships(u) { return (await c.query(`SELECT tenant_id, role FROM tenant_memberships WHERE user_id=$1`, [u])).rows.map((r) => ({ tenantId: r.tenant_id, role: r.role })); },
    async listBilling(t) { return (await c.query(`SELECT plan, entitlement FROM billing_subscriptions WHERE tenant_id=$1`, [t])).rows; },
    async replaceRevokedBilling(t, i) {
      return (await c.query(
        `UPDATE billing_subscriptions SET stripe_customer_id=$2, stripe_subscription_id=$3, subscription_status=$4, entitlement=$5, cancel_at_period_end=false, canceled_at=null, updated_at=now()
         WHERE tenant_id=$1 AND plan='founder_beta_299' AND entitlement='revoked'`, [t, i.customerId, i.subscriptionId, i.subscriptionStatus, i.entitlement])).rowCount ?? 0;
    },
    insertBilling: (t, i) => guarded("billing", async () => {
      await c.query(
        `INSERT INTO billing_subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, purchaser_email, subscription_status, entitlement)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (stripe_subscription_id) DO NOTHING`, [t, i.customerId, i.subscriptionId, i.email, i.subscriptionStatus, i.entitlement]);
    }),
    ensureOwnerMembership: (t, u) => guarded("membership", async () => {
      await c.query(`INSERT INTO tenant_memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner') ON CONFLICT (tenant_id, user_id) DO NOTHING`, [t, u]);
    }),
  };
}

const input = (over: Partial<ProvisionInput> = {}): ProvisionInput => ({ email: `buyer-${randomUUID()}@example.com`, businessName: "Synthetic Co", customerId: "cus_pg", subscriptionId: `sub_${randomUUID().slice(0, 12)}`, subscriptionStatus: "active", entitlement: "active", currentPeriodEnd: null, ...over });
const counts = async (c: C, sub: string, email: string) => ({
  billing: Number((await c.query(`SELECT count(*) n FROM billing_subscriptions WHERE stripe_subscription_id=$1`, [sub])).rows[0].n),
  memberships: Number((await c.query(`SELECT count(*) n FROM tenant_memberships m JOIN auth.users u ON u.id=m.user_id WHERE u.email=$1`, [email])).rows[0].n),
  tenants: Number((await c.query(`SELECT count(*) n FROM tenants WHERE slug LIKE 'beta-%' AND email=$1`, [email])).rows[0].n),
});

DESCRIBE("Founder Beta provisioning order (real Postgres)", () => {
  it("billing failure -> no membership, no billing; retry completes once", () =>
    withRollback(async (c) => {
      const f = { billing: 1, membership: 0 }; const i = input();
      await expect(provisionFounderBeta(pgOps(c, f), i)).rejects.toThrow("billing record creation failed");
      expect(await counts(c, i.subscriptionId, i.email)).toEqual({ billing: 0, memberships: 0, tenants: 1 });
      await provisionFounderBeta(pgOps(c, f), i);
      expect(await counts(c, i.subscriptionId, i.email)).toEqual({ billing: 1, memberships: 1, tenants: 1 });
    }));

  it("membership failure -> durable billing but NO access (RLS sees nothing); retry repairs exactly one membership", () =>
    withRollback(async (c) => {
      const f = { billing: 0, membership: 1 }; const i = input();
      await expect(provisionFounderBeta(pgOps(c, f), i)).rejects.toThrow("membership creation failed");
      expect(await counts(c, i.subscriptionId, i.email)).toEqual({ billing: 1, memberships: 0, tenants: 1 });
      const userId = (await c.query(`SELECT id FROM auth.users WHERE email=$1`, [i.email])).rows[0].id;
      await c.query("SAVEPOINT rls");
      await setRole(c, "authenticated", userId);
      expect((await c.query(`SELECT 1 FROM tenants`)).rowCount).toBe(0);
      expect((await c.query(`SELECT 1 FROM billing_subscriptions`)).rowCount).toBe(0);
      await c.query("ROLLBACK TO SAVEPOINT rls");
      await c.query("RESET ROLE");
      await provisionFounderBeta(pgOps(c, f), i);
      await provisionFounderBeta(pgOps(c, f), i);
      expect(await counts(c, i.subscriptionId, i.email)).toEqual({ billing: 1, memberships: 1, tenants: 1 });
      expect((await c.query(`SELECT entitlement FROM billing_subscriptions WHERE stripe_subscription_id=$1`, [i.subscriptionId])).rows[0].entitlement).toBe("active");
    }));

  it("complete provisioning retried is idempotent and never downgrades/overwrites billing", () =>
    withRollback(async (c) => {
      const f = { billing: 0, membership: 0 }; const i = input();
      await provisionFounderBeta(pgOps(c, f), i);
      await c.query(`UPDATE billing_subscriptions SET entitlement='restricted' WHERE stripe_subscription_id=$1`, [i.subscriptionId]);
      await provisionFounderBeta(pgOps(c, f), { ...i, entitlement: "active" });
      expect(await counts(c, i.subscriptionId, i.email)).toEqual({ billing: 1, memberships: 1, tenants: 1 });
      expect((await c.query(`SELECT entitlement FROM billing_subscriptions WHERE stripe_subscription_id=$1`, [i.subscriptionId])).rows[0].entitlement).toBe("restricted");
    }));

  it("revoked owner re-subscribes into the SAME tenant; active prior purchase requires reconciliation", () =>
    withRollback(async (c) => {
      const f = { billing: 0, membership: 0 }; const first = input();
      await provisionFounderBeta(pgOps(c, f), first);
      const tenantId = (await c.query(`SELECT tenant_id FROM billing_subscriptions WHERE stripe_subscription_id=$1`, [first.subscriptionId])).rows[0].tenant_id;
      const dup = input({ email: first.email });
      await expect(provisionFounderBeta(pgOps(c, f), dup)).rejects.toThrow("RECONCILIATION_REQUIRED:prior_entitlement_active");
      await c.query(`UPDATE billing_subscriptions SET entitlement='revoked', subscription_status='canceled' WHERE tenant_id=$1`, [tenantId]);
      const again = input({ email: first.email });
      await provisionFounderBeta(pgOps(c, f), again);
      const rows = (await c.query(`SELECT tenant_id, stripe_subscription_id, entitlement FROM billing_subscriptions WHERE tenant_id=$1`, [tenantId])).rows;
      expect(rows).toEqual([{ tenant_id: tenantId, stripe_subscription_id: again.subscriptionId, entitlement: "active" }]);
      expect((await c.query(`SELECT count(*)::int n FROM tenants WHERE email=$1`, [first.email])).rows[0].n).toBe(1);
    }));
});
