import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "crypto";
import { getPgTestUrl, withRollback, runConcurrently, insertTenant, insertAgent, insertAgentRun, insertApproval, getPgTestPool } from "../testHarness/pgTestDb";

/**
 * Approval concurrency / payload binding — DATABASE-LEVEL proof (Codex P0
 * audit finding B-03; P0.9 Slice D, D.4).
 *
 * lib/approvals/store.ts::SupabaseApprovalStore.decide/beginExecution are
 * each a single conditional `UPDATE ... WHERE status = '<expected>' ...
 * RETURNING *` — the SAME pattern this file exercises directly with raw SQL
 * against real, separate Postgres connections/transactions. Postgres
 * serializes two concurrent UPDATEs targeting the same row (the second
 * blocks on the row lock until the first commits, then re-evaluates its
 * own WHERE clause against the now-committed row) — this is what actually
 * makes "exactly one caller wins" true, and is not provable by an
 * in-memory re-implementation exercising its own JS-level compare-and-swap
 * logic against itself.
 *
 * Gated on DATABASE_URL/TEST_DATABASE_URL — see lib/testHarness/pgTestDb.ts.
 * Never runs against production; skips cleanly (not silently) when unset.
 */
const DESCRIBE = getPgTestUrl() ? describe : describe.skip;

afterAll(async () => {
  if (getPgTestUrl()) await getPgTestPool().end();
});

function digestOf(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Mirrors SupabaseApprovalStore.decide's exact WHERE-clause shape. */
async function decide(client: import("pg").PoolClient, tenantId: string, id: string, status: "approved" | "rejected") {
  return client.query(`UPDATE public.approvals SET status = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3 AND status = 'pending' RETURNING id`, [
    status,
    tenantId,
    id,
  ]);
}

/** Mirrors SupabaseApprovalStore.beginExecution's exact WHERE-clause shape. */
async function beginExecution(client: import("pg").PoolClient, tenantId: string, id: string, expectedDigest: string) {
  return client.query(
    `UPDATE public.approvals SET status = 'executing', updated_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'approved' AND payload_digest = $3 RETURNING id`,
    [tenantId, id, expectedDigest]
  );
}

async function setupApproval(status: "pending" | "approved" | "executed", payload: Record<string, unknown> = { draft: "hello" }) {
  const pool = getPgTestPool();
  const client = await pool.connect();
  let tenantId!: string;
  let approvalId!: string;
  const digest = digestOf(payload);
  try {
    await client.query("BEGIN");
    tenantId = await insertTenant(client);
    const agentId = await insertAgent(client, tenantId);
    const runId = await insertAgentRun(client, tenantId, agentId);
    approvalId = await insertApproval(client, tenantId, agentId, runId, { status: "pending", payloadDigest: digest });
    await client.query(`UPDATE public.approvals SET payload = $1 WHERE id = $2`, [JSON.stringify(payload), approvalId]);
    if (status === "approved" || status === "executed") {
      await client.query(`UPDATE public.approvals SET status = 'approved' WHERE id = $1`, [approvalId]);
    }
    if (status === "executed") {
      await client.query(`UPDATE public.approvals SET status = 'executed' WHERE id = $1`, [approvalId]);
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  return { tenantId, approvalId, digest, payload };
}

async function cleanup(tenantId: string) {
  const pool = getPgTestPool();
  await pool.query(`DELETE FROM public.approvals WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM public.agent_runs WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM public.agents WHERE tenant_id = $1`, [tenantId]);
  await pool.query(`DELETE FROM public.tenants WHERE id = $1`, [tenantId]);
}

DESCRIBE("approval concurrency / payload binding (migration 017 status machine) — real Postgres proof, not skipped", () => {
  it("1. pending approval + simultaneous approve/approve -> exactly one authoritative winner", async () => {
    const { tenantId, approvalId } = await setupApproval("pending");
    try {
      const results = await runConcurrently([
        (client) => decide(client, tenantId, approvalId, "approved"),
        (client) => decide(client, tenantId, approvalId, "approved"),
      ]);
      const rowCounts = results.map((r) => (r.status === "fulfilled" ? r.value.rowCount : -1));
      // Exactly one UPDATE actually matched a 'pending' row (rowCount 1);
      // the other found the row already 'approved' by then (rowCount 0).
      expect(rowCounts.sort()).toEqual([0, 1]);

      const pool = getPgTestPool();
      const { rows } = await pool.query(`SELECT status FROM public.approvals WHERE id = $1`, [approvalId]);
      expect(rows[0].status).toBe("approved");
    } finally {
      await cleanup(tenantId);
    }
  });

  it("2. pending approval + simultaneous approve/reject -> exactly one winner", async () => {
    const { tenantId, approvalId } = await setupApproval("pending");
    try {
      const results = await runConcurrently([
        (client) => decide(client, tenantId, approvalId, "approved"),
        (client) => decide(client, tenantId, approvalId, "rejected"),
      ]);
      const rowCounts = results.map((r) => (r.status === "fulfilled" ? r.value.rowCount : -1));
      expect(rowCounts.sort()).toEqual([0, 1]);

      const pool = getPgTestPool();
      const { rows } = await pool.query(`SELECT status FROM public.approvals WHERE id = $1`, [approvalId]);
      expect(["approved", "rejected"]).toContain(rows[0].status);
    } finally {
      await cleanup(tenantId);
    }
  });

  it("3. approved approval + simultaneous resume/resume -> only one executor acquires 'executing'", async () => {
    const { tenantId, approvalId, digest } = await setupApproval("approved");
    try {
      const results = await runConcurrently([
        (client) => beginExecution(client, tenantId, approvalId, digest),
        (client) => beginExecution(client, tenantId, approvalId, digest),
      ]);
      const rowCounts = results.map((r) => (r.status === "fulfilled" ? r.value.rowCount : -1));
      expect(rowCounts.sort()).toEqual([0, 1]);

      const pool = getPgTestPool();
      const { rows } = await pool.query(`SELECT status FROM public.approvals WHERE id = $1`, [approvalId]);
      expect(rows[0].status).toBe("executing");
    } finally {
      await cleanup(tenantId);
    }
  });

  it("4. approved payload A + a mutated recomputed digest for payload B -> beginExecution refuses (0 rows affected)", async () => {
    const { tenantId, approvalId } = await setupApproval("approved", { draft: "Payload A — the one actually approved" });
    try {
      const tamperedDigest = digestOf({ draft: "Payload B — never approved" });
      await withRollback(async (client) => {
        const result = await beginExecution(client, tenantId, approvalId, tamperedDigest);
        expect(result.rowCount).toBe(0);
      });

      const pool = getPgTestPool();
      const { rows } = await pool.query(`SELECT status FROM public.approvals WHERE id = $1`, [approvalId]);
      // Still 'approved' — the refused claim never transitioned it.
      expect(rows[0].status).toBe("approved");
    } finally {
      await cleanup(tenantId);
    }
  });

  it("5. redacted tool_call.request_summary mutation does NOT alter approval.payload (structurally decoupled columns)", async () => {
    const payload = { draft: "The real approved draft text" };
    const { tenantId, approvalId, digest } = await setupApproval("approved", payload);
    try {
      const pool = getPgTestPool();
      const runRow = await pool.query(`SELECT agent_run_id FROM public.approvals WHERE id = $1`, [approvalId]);
      const runId = runRow.rows[0].agent_run_id;

      const toolCallInsert = await pool.query(
        `INSERT INTO public.tool_calls (id, tenant_id, agent_run_id, tool_name, action, request_summary, policy_snapshot, approval_id)
         VALUES (gen_random_uuid(), $1, $2, 'draft_customer_message', 'execute', $3::jsonb, '{}'::jsonb, $4) RETURNING id`,
        [tenantId, runId, JSON.stringify({ hasDraft: true, draftLength: payload.draft.length }), approvalId]
      );
      const toolCallId = toolCallInsert.rows[0].id;

      // Mutate the (redacted) audit summary directly.
      await pool.query(`UPDATE public.tool_calls SET request_summary = '{"tampered":true}'::jsonb WHERE id = $1`, [toolCallId]);

      // approval.payload and its payload_digest are untouched by that
      // mutation — they live on a different row entirely (approvals, not
      // tool_calls), and execution (beginExecution) reads only from there.
      const { rows } = await pool.query(`SELECT payload, payload_digest FROM public.approvals WHERE id = $1`, [approvalId]);
      expect(rows[0].payload).toEqual(payload);
      expect(rows[0].payload_digest).toBe(digest);

      // 6. approval.payload is still the execution source: beginExecution
      // still succeeds with the ORIGINAL digest, unaffected by the
      // tool_calls mutation above.
      await withRollback(async (client) => {
        const result = await beginExecution(client, tenantId, approvalId, digest);
        expect(result.rowCount).toBe(1);
      });
    } finally {
      await cleanup(tenantId);
    }
  });

  it("7. an already-'executed' approval cannot be claimed for execution again (0 rows affected)", async () => {
    const { tenantId, approvalId, digest } = await setupApproval("executed");
    try {
      await withRollback(async (client) => {
        const result = await beginExecution(client, tenantId, approvalId, digest);
        expect(result.rowCount).toBe(0);
      });
      const pool = getPgTestPool();
      const { rows } = await pool.query(`SELECT status FROM public.approvals WHERE id = $1`, [approvalId]);
      expect(rows[0].status).toBe("executed");
    } finally {
      await cleanup(tenantId);
    }
  });
});
