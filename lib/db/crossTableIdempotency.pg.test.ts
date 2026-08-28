import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { getPgTestUrl, withRollback, runConcurrently, insertTenant, insertBusinessEvent, getPgTestPool } from "../testHarness/pgTestDb";

/**
 * Cross-table idempotency-index proof — DATABASE-LEVEL (P0.9 Slice D, D.6
 * durable_jobs enqueue idempotency; D.8 business_events replay dedup +
 * correlation/causation chain). Same `UNIQUE (tenant_id, idempotency_key)
 * WHERE idempotency_key IS NOT NULL` partial-index pattern as
 * lib/outcomes/idempotency.pg.test.ts (migration 019) — proved here for
 * business_events (migration 009) and durable_jobs (migration 016), the
 * two other tables that rely on the identical structural guarantee.
 *
 * Gated on DATABASE_URL/TEST_DATABASE_URL — see lib/testHarness/pgTestDb.ts.
 * Never runs against production; skips cleanly (not silently) when unset.
 */
const DESCRIBE = getPgTestUrl() ? describe : describe.skip;

afterAll(async () => {
  if (getPgTestUrl()) await getPgTestPool().end();
});

function pgErrorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null | undefined)?.code;
}
function pgConstraint(err: unknown): string | undefined {
  return (err as { constraint?: string } | null | undefined)?.constraint;
}

async function insertJob(client: import("pg").PoolClient, tenantId: string, idempotencyKey: string | null) {
  return client.query(
    `INSERT INTO public.durable_jobs (id, tenant_id, job_type, payload, idempotency_key) VALUES (gen_random_uuid(), $1, 'test.job', '{}'::jsonb, $2)`,
    [tenantId, idempotencyKey]
  );
}

DESCRIBE("durable_jobs enqueue idempotency (migration 016) — real Postgres proof, not skipped", () => {
  it("D.6: same tenant + same idempotency_key inserted concurrently -> exactly one logical job row, loser fails uq_durable_jobs_tenant_idempotency (23505)", async () => {
    const pool = getPgTestPool();
    const setup = await pool.connect();
    let tenantId!: string;
    try {
      await setup.query("BEGIN");
      tenantId = await insertTenant(setup);
      await setup.query("COMMIT");
    } finally {
      setup.release();
    }
    try {
      const key = `job-key-${randomUUID()}`;
      const results = await runConcurrently([
        async (client) => {
          await client.query("BEGIN");
          await insertJob(client, tenantId, key);
          await client.query("COMMIT");
        },
        async (client) => {
          await client.query("BEGIN");
          await insertJob(client, tenantId, key);
          await client.query("COMMIT");
        },
      ]);
      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      const failure = (failed[0] as { status: "rejected"; reason: unknown }).reason;
      expect(pgErrorCode(failure)).toBe("23505");
      expect(pgConstraint(failure)).toBe("uq_durable_jobs_tenant_idempotency");

      const check = await pool.query(`SELECT count(*)::int AS n FROM public.durable_jobs WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, key]);
      expect(check.rows[0].n).toBe(1);
    } finally {
      await pool.query(`DELETE FROM public.durable_jobs WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM public.tenants WHERE id = $1`, [tenantId]);
    }
  });

  it("D.6: the same idempotency_key under a DIFFERENT tenant is a separate job, never deduped", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      const key = "shared-job-key";
      // Neither insert should throw.
      await insertJob(client, tenantA, key);
      await insertJob(client, tenantB, key);

      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.durable_jobs WHERE idempotency_key = $1`, [key]);
      expect(rows[0].n).toBe(2);
    });
  });
});

DESCRIBE("business event replay dedup + correlation/causation chain (migration 009) — real Postgres proof, not skipped", () => {
  it("D.8: same tenant + same event idempotency key inserted concurrently -> one DB row, loser fails uq_business_events_tenant_idempotency (23505)", async () => {
    const pool = getPgTestPool();
    const setup = await pool.connect();
    let tenantId!: string;
    try {
      await setup.query("BEGIN");
      tenantId = await insertTenant(setup);
      await setup.query("COMMIT");
    } finally {
      setup.release();
    }
    try {
      const key = `event-key-${randomUUID()}`;
      const results = await runConcurrently([
        async (client) => {
          await client.query("BEGIN");
          await insertBusinessEvent(client, tenantId, { idempotencyKey: key });
          await client.query("COMMIT");
        },
        async (client) => {
          await client.query("BEGIN");
          await insertBusinessEvent(client, tenantId, { idempotencyKey: key });
          await client.query("COMMIT");
        },
      ]);
      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      const failure = (failed[0] as { status: "rejected"; reason: unknown }).reason;
      expect(pgErrorCode(failure)).toBe("23505");
      expect(pgConstraint(failure)).toBe("uq_business_events_tenant_idempotency");
    } finally {
      await pool.query(`DELETE FROM public.business_events WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM public.tenants WHERE id = $1`, [tenantId]);
    }
  });

  it("D.8: different tenants + same event idempotency key -> separate rows", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      const key = "shared-event-key";
      await insertBusinessEvent(client, tenantA, { idempotencyKey: key });
      await insertBusinessEvent(client, tenantB, { idempotencyKey: key });

      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.business_events WHERE idempotency_key = $1`, [key]);
      expect(rows[0].n).toBe(2);
    });
  });

  it("D.8: a causation chain persists correctly — call.missed -> lead.created's causation_id points back to it, correlation_id shared across both", async () => {
    await withRollback(async (client) => {
      const tenantId = await insertTenant(client);
      const correlationId = randomUUID();
      const callMissedId = await insertBusinessEvent(client, tenantId, { eventType: "call.missed", correlationId });
      const leadCreatedId = await insertBusinessEvent(client, tenantId, { eventType: "lead.created", correlationId, causationId: callMissedId });
      const smsSentId = await insertBusinessEvent(client, tenantId, { eventType: "recovery.sms_sent", correlationId, causationId: leadCreatedId });

      const { rows } = await client.query(
        `SELECT id, event_type, correlation_id, causation_id FROM public.business_events WHERE id = ANY($1::uuid[]) ORDER BY event_type`,
        [[callMissedId, leadCreatedId, smsSentId]]
      );
      const byType = Object.fromEntries(rows.map((r: any) => [r.event_type, r]));
      expect(byType["call.missed"].correlation_id).toBe(correlationId);
      expect(byType["lead.created"].correlation_id).toBe(correlationId);
      expect(byType["recovery.sms_sent"].correlation_id).toBe(correlationId);
      expect(byType["lead.created"].causation_id).toBe(callMissedId);
      expect(byType["recovery.sms_sent"].causation_id).toBe(leadCreatedId);
      expect(byType["call.missed"].causation_id).toBeNull();
    });
  });

  it("D.8: raw callerPhone is never duplicated as a top-level business_events column — only inside the jsonb payload the application controls", async () => {
    await withRollback(async (client) => {
      const tenantId = await insertTenant(client);
      await insertBusinessEvent(client, tenantId, { eventType: "call.missed" });
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'business_events'`
      );
      const columnNames = rows.map((r: any) => r.column_name);
      expect(columnNames).not.toContain("caller_phone");
      expect(columnNames).not.toContain("phone");
      // The only place a phone number could live is inside `payload`
      // (jsonb, application-controlled) — confirming the schema itself
      // provides no separate raw-PII column for business_events to
      // accidentally duplicate into.
      expect(columnNames).toContain("payload");
    });
  });
});
