import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { getPgTestUrl, withRollback, setRole, insertTenant, insertMembership, getPgTestPool } from "../testHarness/pgTestDb";

/**
 * Founder Beta billing tables — DATABASE-LEVEL proof as real Postgres roles.
 * Two synthetic tenants: each sees only its own billing row, and NO tenant
 * user can insert/update/delete billing state (cannot self-assign paid
 * status or alter entitlement). The webhook ledger is invisible to tenants.
 * Gated on DATABASE_URL like every *.pg.test.ts; skipped (not passed) without it.
 */
const DESCRIBE = getPgTestUrl() ? describe : describe.skip;

afterAll(async () => {
  if (getPgTestUrl()) await getPgTestPool().end();
});

async function seedTwoTenants(c: import("pg").PoolClient) {
  const tA = await insertTenant(c), tB = await insertTenant(c);
  const uA = randomUUID(), uB = randomUUID();
  await insertMembership(c, tA, uA); await insertMembership(c, tB, uB);
  for (const [t, n] of [[tA, "A"], [tB, "B"]] as const) {
    await c.query(
      `INSERT INTO public.billing_subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, subscription_status) VALUES ($1,$2,$3,'active')`,
      [t, `cus_${n}_${t}`, `sub_${n}_${t}`]
    );
  }
  return { tA, tB, uA, uB };
}

DESCRIBE("billing_subscriptions / stripe_webhook_events RLS (real Postgres)", () => {
  it("each tenant reads only its own billing row; the other tenant's is invisible", () =>
    withRollback(async (c) => {
      const { tA, tB, uA, uB } = await seedTwoTenants(c);
      await setRole(c, "authenticated", uA);
      expect((await c.query(`SELECT tenant_id FROM public.billing_subscriptions`)).rows.map((r) => r.tenant_id)).toEqual([tA]);
      await setRole(c, "authenticated", uB);
      expect((await c.query(`SELECT tenant_id FROM public.billing_subscriptions`)).rows.map((r) => r.tenant_id)).toEqual([tB]);
    }));

  it("a tenant user with no membership (empty tenant) sees no billing rows at all", () =>
    withRollback(async (c) => {
      await seedTwoTenants(c);
      const stranger = randomUUID();
      await c.query(`INSERT INTO auth.users (id) VALUES ($1)`, [stranger]);
      await setRole(c, "authenticated", stranger);
      expect((await c.query(`SELECT 1 FROM public.billing_subscriptions`)).rowCount).toBe(0);
    }));

  it("authenticated tenant users cannot self-assign paid status or change entitlement (no write policy)", () =>
    withRollback(async (c) => {
      const { tA, tB, uA } = await seedTwoTenants(c);
      // Make the attempted self-upgrade observable, then compare both tenants
      // as the privileged fixture role after each denied statement recovers.
      await c.query(`UPDATE billing_subscriptions SET entitlement='restricted' WHERE tenant_id=$1`, [tA]);
      const rows = () => c.query(`SELECT * FROM billing_subscriptions WHERE tenant_id=ANY($1::uuid[]) ORDER BY tenant_id`, [[tA,tB]]);
      const before = (await rows()).rows;
      await setRole(c, "authenticated", uA);
      for (const statement of [
        `UPDATE public.billing_subscriptions SET entitlement='active', onboarding_status='complete' WHERE tenant_id=$1`,
        `DELETE FROM public.billing_subscriptions WHERE tenant_id=$1`,
        `INSERT INTO public.billing_subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, subscription_status) VALUES ($1,'cus_x','sub_x','active')`,
      ]) {
        await c.query("SAVEPOINT denied_write");
        await expect(c.query(statement, [tA])).rejects.toMatchObject({ code: "42501" });
        await c.query("ROLLBACK TO SAVEPOINT denied_write");
        await c.query("RELEASE SAVEPOINT denied_write");
      }
      await c.query("RESET ROLE");
      expect((await rows()).rows).toEqual(before);
    }));

  it("anon is refused outright (no EXECUTE on is_tenant_member, migration 003)", () =>
    withRollback(async (c) => {
      await seedTwoTenants(c);
      await setRole(c, "anon");
      await expect(c.query(`SELECT 1 FROM public.billing_subscriptions`)).rejects.toMatchObject({ code: "42501" });
    }));

  it("stripe_webhook_events is invisible and unwritable to tenant users; service_role can use it", () =>
    withRollback(async (c) => {
      const { uA } = await seedTwoTenants(c);
      await c.query(`INSERT INTO public.stripe_webhook_events (event_id, event_type) VALUES ('evt_1','x')`);
      await setRole(c, "authenticated", uA);
      expect((await c.query(`SELECT 1 FROM public.stripe_webhook_events`)).rowCount).toBe(0);
      await c.query("SAVEPOINT s2");
      await expect(c.query(`INSERT INTO public.stripe_webhook_events (event_id, event_type) VALUES ('evt_2','x')`)).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT s2");
      await setRole(c, "service_role");
      expect((await c.query(`SELECT 1 FROM public.stripe_webhook_events`)).rowCount).toBe(1);
    }));

  it("one billing row per tenant and per Stripe subscription (idempotent provisioning backstop)", () =>
    withRollback(async (c) => {
      const { tA } = await seedTwoTenants(c);
      await c.query("SAVEPOINT s3");
      await expect(
        c.query(`INSERT INTO public.billing_subscriptions (tenant_id, stripe_customer_id, stripe_subscription_id, subscription_status) VALUES ($1,'cus_dup','sub_dup','active')`, [tA])
      ).rejects.toMatchObject({ code: "23505" });
    }));
});
