import { describe, it, expect, afterAll } from "vitest";
import { getPgTestUrl, withRollback, runConcurrently, insertTenant, insertAgent, insertAgentRun, getPgTestPool } from "../testHarness/pgTestDb";

/**
 * Outcome idempotency — DATABASE-LEVEL proof (P0.9 Slice C, finding C.3;
 * proved for real in P0.9 Slice D, D.7).
 *
 * Was STATUS: IMPLEMENTED, NOT EXECUTED — every `it` body was a placeholder
 * `expect(true).toBe(true)` because no live test database was reachable
 * (only production, which Slice C/D both forbid writing to). Slice D
 * provisions the disposable Postgres this suite always said it needed;
 * these bodies now run two GENUINELY CONCURRENT raw INSERTs (separate
 * physical connections/transactions, not a single serialized client) and
 * assert on the real uq_outcomes_tenant_idempotency partial unique index
 * from migration 019.
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

async function insertOutcome(client: import("pg").PoolClient, tenantId: string, runId: string, idempotencyKey: string | null) {
  return client.query(
    `INSERT INTO public.outcomes (id, tenant_id, agent_run_id, outcome_type, attribution_confidence, idempotency_key)
     VALUES (gen_random_uuid(), $1, $2, 'admin_time_saved', 'direct', $3)`,
    [tenantId, runId, idempotencyKey]
  );
}

DESCRIBE("outcomes idempotency (migration 019) — real concurrent-insert Postgres proof, not skipped", () => {
  it("two concurrent inserts with the same (tenant_id, idempotency_key) — exactly one row is created, the other fails uq_outcomes_tenant_idempotency (23505)", async () => {
    // Setup rows committed first (outside the race) so both racing inserts
    // reference the same already-durable tenant/run.
    let tenantId!: string;
    let runId!: string;

    const pool = getPgTestPool();
    const setupClient = await pool.connect();
    try {
      await setupClient.query("BEGIN");
      tenantId = await insertTenant(setupClient);
      const agentId = await insertAgent(setupClient, tenantId);
      runId = await insertAgentRun(setupClient, tenantId, agentId);
      await setupClient.query("COMMIT");
    } finally {
      setupClient.release();
    }

    try {
      const key = `race-key-${runId}`;
      const results = await runConcurrently([
        async (client) => {
          await client.query("BEGIN");
          await insertOutcome(client, tenantId, runId, key);
          await client.query("COMMIT");
        },
        async (client) => {
          await client.query("BEGIN");
          await insertOutcome(client, tenantId, runId, key);
          await client.query("COMMIT");
        },
      ]);

      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      const failure = (failed[0] as { status: "rejected"; reason: unknown }).reason;
      expect(pgErrorCode(failure)).toBe("23505");
      expect(pgConstraint(failure)).toBe("uq_outcomes_tenant_idempotency");

      const check = await pool.query(`SELECT count(*)::int AS n FROM public.outcomes WHERE tenant_id = $1 AND idempotency_key = $2`, [tenantId, key]);
      expect(check.rows[0].n).toBe(1);
    } finally {
      // Manual cleanup: this test commits real rows (required to exercise a
      // genuine cross-transaction race), so it cannot rely on ROLLBACK.
      await pool.query(`DELETE FROM public.outcomes WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM public.agent_runs WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM public.agents WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM public.tenants WHERE id = $1`, [tenantId]);
    }
  });

  it("the same idempotency_key under a DIFFERENT tenant_id is not deduped — both rows are created", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      const agentA = await insertAgent(client, tenantA);
      const agentB = await insertAgent(client, tenantB);
      const runA = await insertAgentRun(client, tenantA, agentA);
      const runB = await insertAgentRun(client, tenantB, agentB);

      const key = "shared-key-across-tenants";
      // Neither insert should throw — different tenants, same key.
      await insertOutcome(client, tenantA, runA, key);
      await insertOutcome(client, tenantB, runB, key);

      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.outcomes WHERE idempotency_key = $1`, [key]);
      expect(rows[0].n).toBe(2);
    });
  });

  it("two outcomes with idempotency_key IS NULL are never treated as duplicates of each other", async () => {
    await withRollback(async (client) => {
      const tenant = await insertTenant(client);
      const agent = await insertAgent(client, tenant);
      const run = await insertAgentRun(client, tenant, agent);

      // Neither insert should throw — the partial index's WHERE
      // idempotency_key IS NOT NULL clause means NULLs are never compared.
      await insertOutcome(client, tenant, run, null);
      await insertOutcome(client, tenant, run, null);

      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.outcomes WHERE tenant_id = $1 AND idempotency_key IS NULL`, [tenant]);
      expect(rows[0].n).toBe(2);
    });
  });
});
