import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import {
  getPgTestUrl,
  withRollback,
  insertTenant,
  insertMembership,
  insertAgent,
  insertBusinessEvent,
  getPgTestPool,
} from "../testHarness/pgTestDb";

/**
 * Full P0 exit-criteria demonstration — DATABASE-LEVEL (P0.9 Slice D,
 * D.17). Walks the ENTIRE governed chain against real Postgres in one
 * transaction:
 *
 *   tenant -> business event -> agent -> agent run -> model invocation ->
 *   tool call (approval-gated) -> approval -> payload-bound execution ->
 *   durable-job-style completion -> business outcome
 *
 * then deliberately attempts five violations and proves each is refused:
 * cross-tenant reference, duplicate event replay, duplicate outcome,
 * expired-lease action, duplicate approval execution.
 *
 * This is a raw-SQL walk (not a call into the application's
 * SupabaseXxxStore classes) for the same structural reason every other
 * *.pg.test.ts file in this repo is: those classes go through
 * @supabase/supabase-js -> PostgREST/GoTrue, and this disposable
 * environment is a bare local Postgres (no PostgREST/GoTrue layer — see
 * the Slice D completion report's "disposable environment" section for
 * why). Every SQL statement below mirrors the exact shape the real
 * application code issues (see lib/agents/runtime.ts,
 * lib/approvals/store.ts, lib/execution/store.ts, lib/outcomes/store.ts) —
 * this demonstrates the SCHEMA/CONSTRAINT chain genuinely holds under real
 * Postgres, which is what Slice D is proving; the TypeScript orchestration
 * of that same chain is already proven by lib/agents/runtime.test.ts's own
 * "P0 end-to-end" suite against InMemory stores wired the same way
 * production code wires SupabaseXxxStore.
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

DESCRIBE("P0 full exit-criteria demonstration (D.17) — real Postgres, one governed chain + five refused violations", () => {
  it("walks the entire chain and then proves five distinct violations are each refused", async () => {
    await withRollback(async (client) => {
      // 1. tenant exists
      const tenantId = await insertTenant(client, { name: "5 Star Plumbing (shadow)", slug: `shadow-${randomUUID()}` });
      const ownerUserId = randomUUID();
      await insertMembership(client, tenantId, ownerUserId, "owner");

      // 2. business event emitted
      const correlationId = randomUUID();
      const eventKey = `demo-event-${randomUUID()}`;
      const eventResult = await client.query(
        `INSERT INTO public.business_events (id, tenant_id, event_type, correlation_id, idempotency_key, payload)
         VALUES (gen_random_uuid(), $1, 'test.echo', $2, $3, $4::jsonb) RETURNING id`,
        [tenantId, correlationId, eventKey, JSON.stringify({ note: "P0 exit-criteria demonstration" })]
      );
      const eventId = eventResult.rows[0].id;

      // 3. correct agent loaded
      const agentId = await insertAgent(client, tenantId, { agentType: "dev_test", name: "Dev/Test Agent" });

      // 4. agent run created, tied to the trigger event
      const runResult = await client.query(
        `INSERT INTO public.agent_runs (id, tenant_id, agent_id, trigger_event_id, workflow_id, status, correlation_id)
         VALUES (gen_random_uuid(), $1, $2, $3, 'p0-exit-demo', 'running', $4) RETURNING id`,
        [tenantId, agentId, eventId, correlationId]
      );
      const runId = runResult.rows[0].id;

      // 5. model gateway invoked using an explicit test/mock provider — the
      // real response text never lands here, only its fingerprint (P0.9
      // Slice C correction 3).
      const modelResponseText = "mock model response, never persisted raw";
      const fingerprint = `sha256:${createHash("sha256").update(modelResponseText, "utf8").digest("hex")};chars:${modelResponseText.length}`;
      await client.query(`UPDATE public.agent_runs SET output_summary = $1, model_strategy = $2::jsonb WHERE id = $3`, [
        fingerprint,
        JSON.stringify({ provider: "mock", model: "mock-model", taskType: "reason" }),
        runId,
      ]);
      await client.query(
        `INSERT INTO public.model_invocations (id, tenant_id, agent_run_id, task_type, provider, model, status, input_tokens, output_tokens)
         VALUES (gen_random_uuid(), $1, $2, 'reason', 'mock', 'mock-model', 'succeeded', 12, 8)`,
        [tenantId, runId]
      );

      // 6. policy evaluated -> approval required for this (SEND-permission)
      // tool; 7. approval created; 8. tool_call audit persisted, redacted
      // (no raw draft text — mirrors toolRegistry.ts::draftCustomerMessageTool).
      const draftPayload = { draft: "Hi, following up on your estimate." };
      const digest = createHash("sha256").update(JSON.stringify({ tenantId, agentId, agentRunId: runId, toolName: "draft_customer_message", action: "execute", payload: draftPayload })).digest("hex");
      const approvalResult = await client.query(
        `INSERT INTO public.approvals (id, tenant_id, agent_id, agent_run_id, requested_action, payload, status, payload_digest)
         VALUES (gen_random_uuid(), $1, $2, $3, 'draft_customer_message.execute', $4::jsonb, 'pending', $5) RETURNING id`,
        [tenantId, agentId, runId, JSON.stringify(draftPayload), digest]
      );
      const approvalId = approvalResult.rows[0].id;

      const toolCallResult = await client.query(
        `INSERT INTO public.tool_calls (id, tenant_id, agent_run_id, tool_name, action, request_summary, status, requires_approval, approval_id, policy_snapshot)
         VALUES (gen_random_uuid(), $1, $2, 'draft_customer_message', 'execute', $3::jsonb, 'requires_approval', true, $4, $5::jsonb) RETURNING id`,
        [
          tenantId,
          runId,
          JSON.stringify({ hasDraft: true, draftLength: draftPayload.draft.length }),
          approvalId,
          JSON.stringify({ toolName: "draft_customer_message", decision: "require_approval" }),
        ]
      );
      const toolCallId = toolCallResult.rows[0].id;
      expect(JSON.stringify((await client.query(`SELECT request_summary FROM public.tool_calls WHERE id = $1`, [toolCallId])).rows[0])).not.toContain(
        "Hi, following up"
      );

      // A human approves.
      const decideResult = await client.query(`UPDATE public.approvals SET status = 'approved' WHERE tenant_id = $1 AND id = $2 AND status = 'pending' RETURNING id`, [
        tenantId,
        approvalId,
      ]);
      expect(decideResult.rowCount).toBe(1);

      // 9. approval payload binding verified: beginExecution's exact CAS.
      const claim = await client.query(
        `UPDATE public.approvals SET status = 'executing' WHERE tenant_id = $1 AND id = $2 AND status = 'approved' AND payload_digest = $3 RETURNING id`,
        [tenantId, approvalId, digest]
      );
      expect(claim.rowCount).toBe(1);

      await client.query(`UPDATE public.tool_calls SET status = 'succeeded', response_summary = $1::jsonb, completed_at = now() WHERE id = $2`, [
        JSON.stringify({ hasDraft: true, draftLength: draftPayload.draft.length }),
        toolCallId,
      ]);
      await client.query(`UPDATE public.approvals SET status = 'executed', execution_result = '{"ok":true}'::jsonb WHERE id = $1`, [approvalId]);

      // 10. durable execution state verified: a durable job for the same
      // logical work, claimed and completed under a real lease.
      const jobResult = await client.query(
        `INSERT INTO public.durable_jobs (id, tenant_id, job_type, payload, status, correlation_id, idempotency_key)
         VALUES (gen_random_uuid(), $1, 'demo.followup', '{}'::jsonb, 'queued', $2, $3) RETURNING id`,
        [tenantId, correlationId, `demo-job-${runId}`]
      );
      const jobId = jobResult.rows[0].id;
      const jobClaim = await client.query(
        `UPDATE public.durable_jobs SET status='running', locked_by='demo-worker', lease_token=gen_random_uuid(), lock_expires_at = clock_timestamp() + interval '300 seconds', attempts = attempts + 1
         WHERE id = $1 AND status = 'queued' RETURNING lease_token`,
        [jobId]
      );
      expect(jobClaim.rowCount).toBe(1);
      const leaseToken = jobClaim.rows[0].lease_token;
      const jobComplete = await client.query(
        `UPDATE public.durable_jobs SET status='succeeded', completed_at=now(), lease_token=NULL WHERE id=$1 AND status='running' AND lease_token=$2 AND lock_expires_at > clock_timestamp() RETURNING id`,
        [jobId, leaseToken]
      );
      expect(jobComplete.rowCount).toBe(1);

      // 11. agent run finishes truthfully.
      await client.query(`UPDATE public.agent_runs SET status = 'succeeded', completed_at = now() WHERE id = $1`, [runId]);

      // 12. business outcome recorded, 13. attribution confidence explicit.
      const outcomeKey = `demo-outcome-${runId}`;
      const outcomeResult = await client.query(
        `INSERT INTO public.outcomes (id, tenant_id, agent_run_id, outcome_type, attribution_confidence, idempotency_key)
         VALUES (gen_random_uuid(), $1, $2, 'admin_time_saved', 'direct', $3) RETURNING id`,
        [tenantId, runId, outcomeKey]
      );
      const outcomeId = outcomeResult.rows[0].id;

      // 14. all rows belong to the same tenant.
      const tenantCheck = await client.query(
        `SELECT
           (SELECT tenant_id FROM public.business_events WHERE id = $1) AS event_tenant,
           (SELECT tenant_id FROM public.agent_runs WHERE id = $2) AS run_tenant,
           (SELECT tenant_id FROM public.approvals WHERE id = $3) AS approval_tenant,
           (SELECT tenant_id FROM public.tool_calls WHERE id = $4) AS tool_call_tenant,
           (SELECT tenant_id FROM public.outcomes WHERE id = $5) AS outcome_tenant`,
        [eventId, runId, approvalId, toolCallId, outcomeId]
      );
      const row = tenantCheck.rows[0];
      expect(new Set([row.event_tenant, row.run_tenant, row.approval_tenant, row.tool_call_tenant, row.outcome_tenant])).toEqual(new Set([tenantId]));

      // 15. correlation/workflow/run IDs connect the chain.
      const chainCheck = await client.query(
        `SELECT
           (SELECT correlation_id FROM public.agent_runs WHERE id = $1) AS run_correlation,
           (SELECT trigger_event_id FROM public.agent_runs WHERE id = $1) AS run_trigger_event,
           (SELECT agent_run_id FROM public.tool_calls WHERE id = $2) AS tool_call_run,
           (SELECT agent_run_id FROM public.outcomes WHERE id = $3) AS outcome_run`,
        [runId, toolCallId, outcomeId]
      );
      expect(chainCheck.rows[0].run_correlation).toBe(correlationId);
      expect(chainCheck.rows[0].run_trigger_event).toBe(eventId);
      expect(chainCheck.rows[0].tool_call_run).toBe(runId);
      expect(chainCheck.rows[0].outcome_run).toBe(runId);

      // 16. no prohibited raw PII in orchestration/audit records.
      const auditDump = await client.query(
        `SELECT
           (SELECT request_summary FROM public.tool_calls WHERE id = $1) AS req_summary,
           (SELECT response_summary FROM public.tool_calls WHERE id = $1) AS resp_summary,
           (SELECT output_summary FROM public.agent_runs WHERE id = $2) AS output_summary`,
        [toolCallId, runId]
      );
      const serialized = JSON.stringify(auditDump.rows[0]);
      expect(serialized).not.toContain("Hi, following up");
      expect(serialized).not.toContain(modelResponseText);

      // ===================================================================
      // Now deliberately attempt five violations and prove each is refused.
      //
      // Each violating statement runs inside its own SAVEPOINT: a failed
      // statement poisons the REST of the enclosing transaction in
      // Postgres (every later statement fails with 25P02
      // in_failed_sql_transaction) until an explicit rollback — a
      // SAVEPOINT + ROLLBACK TO SAVEPOINT is the standard way to recover
      // from one expected failure and keep testing the next violation in
      // the same outer transaction.
      // ===================================================================

      async function expectRefused(fn: () => Promise<unknown>, expectedCode: string) {
        await client.query("SAVEPOINT violation_check");
        let err: unknown;
        try {
          await fn();
        } catch (e) {
          err = e;
        }
        await client.query("ROLLBACK TO SAVEPOINT violation_check");
        expect(pgErrorCode(err)).toBe(expectedCode);
      }

      // (a) cross-tenant reference.
      const otherTenantId = await insertTenant(client);
      await expectRefused(
        () => client.query(`INSERT INTO public.agent_runs (id, tenant_id, agent_id, status) VALUES (gen_random_uuid(), $1, $2, 'pending')`, [otherTenantId, agentId]),
        "23503"
      );

      // (b) duplicate event replay (same tenant, same idempotency key).
      await expectRefused(
        () =>
          client.query(`INSERT INTO public.business_events (id, tenant_id, event_type, idempotency_key) VALUES (gen_random_uuid(), $1, 'test.echo', $2)`, [
            tenantId,
            eventKey,
          ]),
        "23505"
      );

      // (c) duplicate outcome (same tenant, same idempotency key).
      await expectRefused(
        () =>
          client.query(
            `INSERT INTO public.outcomes (id, tenant_id, agent_run_id, outcome_type, attribution_confidence, idempotency_key)
             VALUES (gen_random_uuid(), $1, $2, 'admin_time_saved', 'direct', $3)`,
            [tenantId, runId, outcomeKey]
          ),
        "23505"
      );

      // (d) expired-lease action: force-expire the completed job's ORIGINAL
      // lease scenario by claiming a fresh job, expiring it, then trying to
      // complete it with the (now-stale) token.
      const job2 = await client.query(`INSERT INTO public.durable_jobs (id, tenant_id, job_type, payload, status) VALUES (gen_random_uuid(), $1, 'demo.job2', '{}'::jsonb, 'queued') RETURNING id`, [
        tenantId,
      ]);
      const job2Claim = await client.query(
        `UPDATE public.durable_jobs SET status='running', lease_token=gen_random_uuid(), lock_expires_at = clock_timestamp() + interval '300 seconds' WHERE id=$1 RETURNING lease_token`,
        [job2.rows[0].id]
      );
      const staleToken = job2Claim.rows[0].lease_token;
      await client.query(`UPDATE public.durable_jobs SET lock_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [job2.rows[0].id]);
      const expiredComplete = await client.query(
        `UPDATE public.durable_jobs SET status='succeeded' WHERE id=$1 AND status='running' AND lease_token=$2 AND lock_expires_at > clock_timestamp() RETURNING id`,
        [job2.rows[0].id, staleToken]
      );
      expect(expiredComplete.rowCount).toBe(0);

      // (e) duplicate approval execution: the approval above is already
      // 'executed' — a second beginExecution-style claim must be refused.
      const secondClaim = await client.query(
        `UPDATE public.approvals SET status = 'executing' WHERE tenant_id = $1 AND id = $2 AND status = 'approved' AND payload_digest = $3 RETURNING id`,
        [tenantId, approvalId, digest]
      );
      expect(secondClaim.rowCount).toBe(0);
      const finalApproval = await client.query(`SELECT status FROM public.approvals WHERE id = $1`, [approvalId]);
      expect(finalApproval.rows[0].status).toBe("executed");
    });
  });
});
