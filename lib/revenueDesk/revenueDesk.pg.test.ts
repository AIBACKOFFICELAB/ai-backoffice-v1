import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { getPgTestUrl, getPgTestPool, withRollback, setRole, insertTenant, insertMembership, insertLead, runConcurrently } from "../testHarness/pgTestDb";

/**
 * Revenue Desk (migration 026) — real Postgres proof as real roles.
 * Gated on DATABASE_URL like every *.pg.test.ts; skipped (not passed) without it.
 */
const DESCRIBE = getPgTestUrl() ? describe : describe.skip;
afterAll(async () => { if (getPgTestUrl()) await getPgTestPool().end(); });

type C = import("pg").PoolClient;
async function call(c: C, tenantId: string, providerCallId = `vapi-${randomUUID()}`, leadId: string | null = null) {
  const r = await c.query(`INSERT INTO public.revenue_desk_calls (tenant_id, provider_call_id, lead_id) VALUES ($1,$2,$3) RETURNING id`, [tenantId, providerCallId, leadId]);
  return r.rows[0].id as string;
}
async function booking(c: C, tenantId: string, callId: string, over: { key?: string; start?: string; status?: string; calendar?: string } = {}) {
  const start = over.start ?? "2026-10-12T14:00:00Z";
  return c.query(
    `INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone, status, provider_event_id)
     VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + interval '1 hour','America/New_York',$6,$7) RETURNING id`,
    [tenantId, callId, over.key ?? randomUUID(), over.calendar ?? "cal-a", start, over.status ?? "pending", over.status === "confirmed" ? "ev-1" : null]
  );
}
const code = (e: unknown) => (e as { code?: string })?.code;
async function expectCode(c: C, p: () => Promise<unknown>, expected: string) {
  await c.query("SAVEPOINT sp");
  await expect(p()).rejects.toMatchObject({ code: expected });
  await c.query("ROLLBACK TO SAVEPOINT sp");
}

DESCRIBE("Revenue Desk schema + RLS (real Postgres)", () => {
  it("members read only their own tenant's settings/calls/bookings; strangers and other tenants see nothing", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c), tB = await insertTenant(c);
      const uA = randomUUID(), uB = randomUUID();
      await insertMembership(c, tA, uA); await insertMembership(c, tB, uB);
      for (const t of [tA, tB]) {
        await c.query(`INSERT INTO public.revenue_desk_settings (tenant_id, escalation_phone, calendar_id) VALUES ($1,'+13055550100','cal')`, [t]);
        await booking(c, t, await call(c, t));
      }
      await setRole(c, "authenticated", uA);
      for (const table of ["revenue_desk_settings", "revenue_desk_calls", "revenue_desk_bookings"]) {
        const rows = (await c.query(`SELECT tenant_id FROM public.${table}`)).rows.map((r) => r.tenant_id);
        expect(rows, table).toEqual([tA]);
      }
    }));

  it("tenant members cannot write config (escalation phone/calendar), calls, or bookings", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c); const uA = randomUUID(); await insertMembership(c, tA, uA);
      await c.query(`INSERT INTO public.revenue_desk_settings (tenant_id, escalation_phone) VALUES ($1,'+13055550100')`, [tA]);
      const callId = await call(c, tA);
      await setRole(c, "authenticated", uA);
      expect((await c.query(`UPDATE public.revenue_desk_settings SET escalation_phone='+19995550000', enabled=true WHERE tenant_id=$1`, [tA])).rowCount).toBe(0);
      expect((await c.query(`UPDATE public.revenue_desk_calls SET status='booked' WHERE tenant_id=$1`, [tA])).rowCount).toBe(0);
      await expectCode(c, () => c.query(`INSERT INTO public.revenue_desk_calls (tenant_id, provider_call_id) VALUES ($1,'x')`, [tA]), "42501");
      await expectCode(c, () => booking(c, tA, callId), "42501");
    }));

  it("anon is refused", () =>
    withRollback(async (c) => {
      await setRole(c, "anon");
      await expect(c.query(`SELECT 1 FROM public.revenue_desk_calls`)).rejects.toMatchObject({ code: "42501" });
    }));

  it("duplicate provider call id per tenant is refused (replay-safe); same id under another tenant is isolated", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c), tB = await insertTenant(c);
      await call(c, tA, "vapi-dup");
      await expectCode(c, () => call(c, tA, "vapi-dup"), "23505");
      await call(c, tB, "vapi-dup");
    }));

  it("call/booking cannot reference another tenant's lead or call (composite FKs)", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c), tB = await insertTenant(c);
      const leadB = await insertLead(c, tB);
      await expectCode(c, () => call(c, tA, undefined, leadB), "23503");
      const callB = await call(c, tB);
      await expectCode(c, () => booking(c, tA, callB), "23503");
      const leadA = await insertLead(c, tA);
      await call(c, tA, undefined, leadA); // same-tenant link is fine
    }));

  it("booking idempotency key, one live booking per call, and the per-calendar slot guard are DB-enforced", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c);
      const c1 = await call(c, tA), c2 = await call(c, tA);
      await booking(c, tA, c1, { key: "k1" });
      await expectCode(c, () => booking(c, tA, c2, { key: "k1", start: "2026-10-13T14:00:00Z" }), "23505"); // idempotency
      await expectCode(c, () => booking(c, tA, c1, { start: "2026-10-14T14:00:00Z" }), "23505"); // live per call
      await expectCode(c, () => booking(c, tA, c2), "23505"); // same slot, same calendar
      await booking(c, tA, c2, { calendar: "cal-other" }); // other calendar ok
      await c.query(`UPDATE public.revenue_desk_bookings SET status='conflict' WHERE idempotency_key='k1'`);
      const c3 = await call(c, tA);
      await booking(c, tA, c3); // slot reopens once the earlier booking is no longer live
    }));

  it("confirmed requires a provider event id; end must follow start", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c); const c1 = await call(c, tA);
      await expectCode(c, () => c.query(`INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone, status) VALUES ($1,$2,'k','cal',now(),now()+interval '1h','UTC','confirmed')`, [tA, c1]), "23514");
      await expectCode(c, () => c.query(`INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone) VALUES ($1,$2,'k2','cal',now(),now()-interval '1h','UTC')`, [tA, c1]), "23514");
    }));

  it("canonical voice lead is idempotent on (tenant, source, source_ref=callId)", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c); const ref = randomUUID();
      const lead = async () => {
        const id = await insertLead(c, tA);
        await c.query(`UPDATE public.leads SET source='voice_receptionist', source_ref=$1 WHERE id=$2`, [ref, id]);
      };
      await lead();
      await expectCode(c, () => lead(), "23505");
    }));
});

DESCRIBE("Revenue Desk concurrency (separate real transactions)", () => {
  it("concurrent duplicate callbacks create exactly one call row", async () => {
    const pool = getPgTestPool();
    const tA = (await pool.query(`INSERT INTO public.tenants (name, slug) VALUES ('rd-conc', $1) RETURNING id`, [`rd-${randomUUID()}`])).rows[0].id;
    try {
      const results = await runConcurrently(Array.from({ length: 5 }, () => async (c: C) => {
        await c.query("BEGIN");
        await c.query(`INSERT INTO public.revenue_desk_calls (tenant_id, provider_call_id) VALUES ($1,'same-call')`, [tA]);
        await c.query("COMMIT");
      }));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected").every((r) => code((r as any).reason) === "23505")).toBe(true);
      expect((await pool.query(`SELECT count(*)::int n FROM public.revenue_desk_calls WHERE tenant_id=$1`, [tA])).rows[0].n).toBe(1);
    } finally {
      await pool.query(`DELETE FROM public.tenants WHERE id=$1`, [tA]);
    }
  });

  it("concurrent booking attempts for the same slot: exactly one live booking", async () => {
    const pool = getPgTestPool();
    const tA = (await pool.query(`INSERT INTO public.tenants (name, slug) VALUES ('rd-conc2', $1) RETURNING id`, [`rd-${randomUUID()}`])).rows[0].id;
    try {
      const callIds = [];
      for (let i = 0; i < 4; i++) callIds.push((await pool.query(`INSERT INTO public.revenue_desk_calls (tenant_id, provider_call_id) VALUES ($1,$2) RETURNING id`, [tA, `c${i}`])).rows[0].id);
      const results = await runConcurrently(callIds.map((id) => async (c: C) => {
        await c.query("BEGIN");
        await c.query(`INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone) VALUES ($1,$2,$3,'cal','2026-10-12T14:00:00Z','2026-10-12T15:00:00Z','UTC')`, [tA, id, `k-${id}`]);
        await c.query("COMMIT");
      }));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await pool.query(`SELECT count(*)::int n FROM public.revenue_desk_bookings WHERE tenant_id=$1`, [tA])).rows[0].n).toBe(1);
    } finally {
      await pool.query(`DELETE FROM public.tenants WHERE id=$1`, [tA]);
    }
  });
});
