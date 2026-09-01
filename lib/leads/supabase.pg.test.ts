import { describe, it, expect, afterAll } from "vitest";
import { getPgTestUrl, insertTenant, insertLead, getPgTestPool } from "../testHarness/pgTestDb";

/**
 * P1 Sprint 4 — DATABASE-LEVEL proof of the compare-and-swap pattern
 * lib/leads/supabase.ts::updateLeadInDb's `expectedCurrentStatus` option
 * relies on: `UPDATE leads SET ... WHERE id = $1 AND tenant_id = $2 AND
 * status = $expected`. updateLeadInDb itself calls createServerSupabaseClient
 * (next/headers::cookies()), which requires a real Next.js request context
 * and cannot run inside a plain Vitest test — so this proves the underlying
 * SQL semantics directly against real Postgres instead, mirroring
 * lib/agents/estimateClosing/stalledScan.pg.test.ts's approach of proving
 * a real database guarantee rather than an application-level mock.
 *
 * Fixes a Codex review finding on PR #23: without this WHERE-clause
 * constraint, a request validating against a lead's status BEFORE a
 * concurrent request closes it (Won/Lost/Completed) could silently
 * overwrite that closure back to "Estimate Sent" and enroll a closed
 * customer in follow-up.
 *
 * Gated on DATABASE_URL/TEST_DATABASE_URL — see lib/testHarness/pgTestDb.ts.
 * Never runs against production; skips cleanly (not silently) when unset.
 */
const DESCRIBE = getPgTestUrl() ? describe : describe.skip;

afterAll(async () => {
  if (getPgTestUrl()) await getPgTestPool().end();
});

DESCRIBE("leads CAS-by-status pattern (Codex review finding on PR #23) — real Postgres proof", () => {
  it("a conditional UPDATE ... WHERE status = $expected affects zero rows once a concurrent write already changed the status, and never overwrites the newer value", async () => {
    const pool = getPgTestPool();
    let tenantId!: string;
    let leadId!: string;

    const setupClient = await pool.connect();
    try {
      await setupClient.query("BEGIN");
      tenantId = await insertTenant(setupClient);
      leadId = await insertLead(setupClient, tenantId, { status: "New" });
      await setupClient.query("COMMIT");
    } finally {
      setupClient.release();
    }

    try {
      // Simulates: this route validated against status='New', then a
      // SEPARATE, concurrent request closed the lead before this route's
      // own write executed.
      const closer = await pool.connect();
      try {
        await closer.query(`UPDATE public.leads SET status = 'Won' WHERE id = $1 AND tenant_id = $2`, [leadId, tenantId]);
      } finally {
        closer.release();
      }

      // This route's own CAS write, still believing status is 'New'.
      const casResult = await pool.query(
        `UPDATE public.leads SET status = 'Estimate Sent' WHERE id = $1 AND tenant_id = $2 AND status = 'New' RETURNING id`,
        [leadId, tenantId]
      );
      expect(casResult.rowCount).toBe(0);

      const check = await pool.query(`SELECT status FROM public.leads WHERE id = $1 AND tenant_id = $2`, [leadId, tenantId]);
      expect(check.rows[0].status).toBe("Won"); // never overwritten back to Estimate Sent
    } finally {
      const cleanupClient = await pool.connect();
      try {
        await cleanupClient.query(`DELETE FROM public.leads WHERE tenant_id = $1`, [tenantId]);
        await cleanupClient.query(`DELETE FROM public.tenants WHERE id = $1`, [tenantId]);
      } finally {
        cleanupClient.release();
      }
    }
  });

  it("the conditional UPDATE succeeds and returns the row when status still matches what was validated", async () => {
    const pool = getPgTestPool();
    let tenantId!: string;
    let leadId!: string;

    const setupClient = await pool.connect();
    try {
      await setupClient.query("BEGIN");
      tenantId = await insertTenant(setupClient);
      leadId = await insertLead(setupClient, tenantId, { status: "New" });
      await setupClient.query("COMMIT");
    } finally {
      setupClient.release();
    }

    try {
      const casResult = await pool.query(
        `UPDATE public.leads SET status = 'Estimate Sent' WHERE id = $1 AND tenant_id = $2 AND status = 'New' RETURNING id, status`,
        [leadId, tenantId]
      );
      expect(casResult.rowCount).toBe(1);
      expect(casResult.rows[0].status).toBe("Estimate Sent");
    } finally {
      const cleanupClient = await pool.connect();
      try {
        await cleanupClient.query(`DELETE FROM public.leads WHERE tenant_id = $1`, [tenantId]);
        await cleanupClient.query(`DELETE FROM public.tenants WHERE id = $1`, [tenantId]);
      } finally {
        cleanupClient.release();
      }
    }
  });
});
