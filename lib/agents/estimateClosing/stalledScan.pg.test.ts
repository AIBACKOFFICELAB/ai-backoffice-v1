import { describe, it, expect, afterAll } from "vitest";
import { getPgTestUrl, runConcurrently, insertTenant, insertBusinessEvent, getPgTestPool } from "../../testHarness/pgTestDb";
import { buildStalledIdempotencyKey } from "./stalledScan";

/**
 * P1A dedupe — DATABASE-LEVEL proof that two genuinely concurrent scan
 * runs discovering the SAME stalled estimate can only ever produce one
 * estimate.stalled row, via the real uq_business_events_tenant_idempotency
 * unique index (migration 009) — not merely the application-level
 * pre-check in lib/events/store.ts::SupabaseBusinessEventStore.insert,
 * which is a fast path, not the guarantee. Mirrors
 * lib/outcomes/idempotency.pg.test.ts's exact pattern (two separate
 * physical connections racing a real INSERT), applied to the event this
 * agent's trigger actually uses. See stalledScan.ts's own doc comment for
 * why this identity ("one estimate_followup_sequences row = one possible
 * stalled event, ever") is what makes a stable, non-time-based
 * idempotencyKey correct here.
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

DESCRIBE("estimate.stalled idempotency (migration 009) — real concurrent-insert Postgres proof", () => {
  it("two concurrent 'scan discovered the same stalled sequence' inserts produce exactly one row", async () => {
    const pool = getPgTestPool();
    let tenantId!: string;

    const setupClient = await pool.connect();
    try {
      await setupClient.query("BEGIN");
      tenantId = await insertTenant(setupClient);
      await setupClient.query("COMMIT");
    } finally {
      setupClient.release();
    }

    try {
      const sequenceId = "11111111-1111-1111-1111-111111111111";
      const key = buildStalledIdempotencyKey(sequenceId);

      const results = await runConcurrently([
        async (client) => {
          await client.query("BEGIN");
          await insertBusinessEvent(client, tenantId, { eventType: "estimate.stalled", idempotencyKey: key });
          await client.query("COMMIT");
        },
        async (client) => {
          await client.query("BEGIN");
          await insertBusinessEvent(client, tenantId, { eventType: "estimate.stalled", idempotencyKey: key });
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

      const check = await pool.query(
        `SELECT count(*)::int AS n FROM public.business_events WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, key]
      );
      expect(check.rows[0].n).toBe(1);
    } finally {
      await pool.query(`DELETE FROM public.business_events WHERE tenant_id = $1`, [tenantId]);
      await pool.query(`DELETE FROM public.tenants WHERE id = $1`, [tenantId]);
    }
  });
});
