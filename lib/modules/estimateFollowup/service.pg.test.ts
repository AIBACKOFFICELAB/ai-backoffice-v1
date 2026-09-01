import { describe, it, expect, afterAll } from "vitest";
import { getPgTestUrl, runConcurrently, insertTenant, insertLead, getPgTestPool } from "../../testHarness/pgTestDb";

/**
 * P1 Sprint 4 — DATABASE-LEVEL proof that two genuinely concurrent
 * "enroll this lead in follow-up" attempts for the SAME lead can only ever
 * produce one estimate_followup_sequences row, via the real
 * `UNIQUE (tenant_id, lead_id)` constraint (migration 005) — not merely the
 * application-level pre-check in
 * lib/modules/estimateFollowup/service.ts::enrollLeadInFollowup, which is a
 * fast path, not the guarantee. Mirrors
 * lib/agents/estimateClosing/stalledScan.pg.test.ts's exact pattern (two
 * separate physical connections racing a real INSERT).
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

DESCRIBE("estimate_followup_sequences UNIQUE(tenant_id, lead_id) (migration 005) — real concurrent-insert Postgres proof", () => {
  it("two concurrent enrollment inserts for the same lead produce exactly one row; the loser fails with a 23505 unique violation", async () => {
    const pool = getPgTestPool();
    let tenantId!: string;
    let leadId!: string;

    const setupClient = await pool.connect();
    try {
      await setupClient.query("BEGIN");
      tenantId = await insertTenant(setupClient);
      leadId = await insertLead(setupClient, tenantId, { status: "Estimate Sent", estimateAmount: 1500 });
      await setupClient.query("COMMIT");
    } finally {
      setupClient.release();
    }

    try {
      const insertSequence = async (client: import("pg").PoolClient) => {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO public.estimate_followup_sequences
             (tenant_id, lead_id, estimate_sent_at, day1_due_at, day3_due_at, day7_due_at, status)
           VALUES ($1, $2, now(), now() + interval '1 day', now() + interval '3 days', now() + interval '7 days', 'active')`,
          [tenantId, leadId]
        );
        await client.query("COMMIT");
      };

      const results = await runConcurrently([insertSequence, insertSequence]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(pgErrorCode((rejected[0] as { status: "rejected"; reason: unknown }).reason)).toBe("23505");

      const check = await pool.query(`SELECT count(*)::int AS n FROM public.estimate_followup_sequences WHERE tenant_id = $1 AND lead_id = $2`, [tenantId, leadId]);
      expect(check.rows[0].n).toBe(1);
    } finally {
      const cleanupClient = await pool.connect();
      try {
        await cleanupClient.query(`DELETE FROM public.estimate_followup_sequences WHERE tenant_id = $1`, [tenantId]);
        await cleanupClient.query(`DELETE FROM public.leads WHERE tenant_id = $1`, [tenantId]);
        await cleanupClient.query(`DELETE FROM public.tenants WHERE id = $1`, [tenantId]);
      } finally {
        cleanupClient.release();
      }
    }
  });
});
