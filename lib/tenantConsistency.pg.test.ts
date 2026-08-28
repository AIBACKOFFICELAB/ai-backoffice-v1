import { describe, it, expect, afterAll } from "vitest";
import {
  getPgTestUrl,
  withRollback,
  insertTenant,
  insertAgent,
  insertAgentRun,
  insertApproval,
  insertBusinessEvent,
  getPgTestPool,
} from "./testHarness/pgTestDb";

/**
 * Tenant-consistent relationship enforcement — DATABASE-LEVEL proof
 * (Codex P0 audit finding B-01; P0.9 Slice D, D.3).
 *
 * Was STATUS: IMPLEMENTED, NOT EXECUTED (every `it` body was a placeholder
 * `expect(true).toBe(true)`) — see git history for the original comment
 * explaining why an in-memory re-implementation cannot prove a
 * database-enforced composite foreign key without being circular. Slice D
 * provides the disposable Postgres this suite always said it needed; these
 * bodies are now real INSERTs against a real Postgres with migration 017
 * applied, asserting on the real 23503/23505 error the constraint raises.
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

DESCRIBE("tenant-consistent composite foreign keys (migration 017) — real Postgres proof, not skipped", () => {
  it("agent_runs.agent_id: tenant A run referencing tenant B's agent is rejected by agent_runs_tenant_agent_fkey", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      const agentB = await insertAgent(client, tenantB);

      let err: unknown;
      try {
        await client.query(`INSERT INTO public.agent_runs (id, tenant_id, agent_id, status) VALUES (gen_random_uuid(), $1, $2, 'pending')`, [tenantA, agentB]);
      } catch (e) {
        err = e;
      }
      expect(pgErrorCode(err)).toBe("23503");
      expect(pgConstraint(err)).toBe("agent_runs_tenant_agent_fkey");
    });
  });

  it("agent_runs.trigger_event_id: a business_event from a different tenant is rejected by agent_runs_tenant_trigger_event_fkey", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      const agentA = await insertAgent(client, tenantA);
      const eventB = await insertBusinessEvent(client, tenantB);

      let err: unknown;
      try {
        await client.query(
          `INSERT INTO public.agent_runs (id, tenant_id, agent_id, trigger_event_id, status) VALUES (gen_random_uuid(), $1, $2, $3, 'pending')`,
          [tenantA, agentA, eventB]
        );
      } catch (e) {
        err = e;
      }
      expect(pgErrorCode(err)).toBe("23503");
      expect(pgConstraint(err)).toBe("agent_runs_tenant_trigger_event_fkey");
    });
  });

  it("approvals.agent_id: an agent from a different tenant is rejected by approvals_tenant_agent_fkey", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      const agentA = await insertAgent(client, tenantA);
      const agentB = await insertAgent(client, tenantB);
      const runA = await insertAgentRun(client, tenantA, agentA);

      let err: unknown;
      try {
        await client.query(
          `INSERT INTO public.approvals (id, tenant_id, agent_id, agent_run_id, requested_action, payload_digest)
           VALUES (gen_random_uuid(), $1, $2, $3, 'test.action', 'd')`,
          [tenantA, agentB, runA]
        );
      } catch (e) {
        err = e;
      }
      expect(pgErrorCode(err)).toBe("23503");
      expect(pgConstraint(err)).toBe("approvals_tenant_agent_fkey");
    });
  });

  it("approvals.agent_run_id: an agent_run from a different tenant is rejected by approvals_tenant_agent_run_fkey", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      const agentA = await insertAgent(client, tenantA);
      const agentB = await insertAgent(client, tenantB);
      const runB = await insertAgentRun(client, tenantB, agentB);

      let err: unknown;
      try {
        await client.query(
          `INSERT INTO public.approvals (id, tenant_id, agent_id, agent_run_id, requested_action, payload_digest)
           VALUES (gen_random_uuid(), $1, $2, $3, 'test.action', 'd')`,
          [tenantA, agentA, runB]
        );
      } catch (e) {
        err = e;
      }
      expect(pgErrorCode(err)).toBe("23503");
      expect(pgConstraint(err)).toBe("approvals_tenant_agent_run_fkey");
    });
  });

  it("tool_calls.agent_run_id: an agent_run from a different tenant is rejected by tool_calls_tenant_agent_run_fkey", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      const agentB = await insertAgent(client, tenantB);
      const runB = await insertAgentRun(client, tenantB, agentB);

      let err: unknown;
      try {
        await client.query(
          `INSERT INTO public.tool_calls (id, tenant_id, agent_run_id, tool_name, action, policy_snapshot)
           VALUES (gen_random_uuid(), $1, $2, 'ping', 'execute', '{}'::jsonb)`,
          [tenantA, runB]
        );
      } catch (e) {
        err = e;
      }
      expect(pgErrorCode(err)).toBe("23503");
      expect(pgConstraint(err)).toBe("tool_calls_tenant_agent_run_fkey");
    });
  });

  it("tool_calls.approval_id: an approval from a different tenant is rejected by tool_calls_tenant_approval_fkey", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      const agentA = await insertAgent(client, tenantA);
      const agentB = await insertAgent(client, tenantB);
      const runA = await insertAgentRun(client, tenantA, agentA);
      const runB = await insertAgentRun(client, tenantB, agentB);
      const approvalB = await insertApproval(client, tenantB, agentB, runB);

      let err: unknown;
      try {
        await client.query(
          `INSERT INTO public.tool_calls (id, tenant_id, agent_run_id, tool_name, action, policy_snapshot, approval_id)
           VALUES (gen_random_uuid(), $1, $2, 'ping', 'execute', '{}'::jsonb, $3)`,
          [tenantA, runA, approvalB]
        );
      } catch (e) {
        err = e;
      }
      expect(pgErrorCode(err)).toBe("23503");
      expect(pgConstraint(err)).toBe("tool_calls_tenant_approval_fkey");
    });
  });

  it("model_invocations.agent_run_id: an agent_run from a different tenant is rejected by model_invocations_tenant_agent_run_fkey", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      const agentB = await insertAgent(client, tenantB);
      const runB = await insertAgentRun(client, tenantB, agentB);

      let err: unknown;
      try {
        await client.query(
          `INSERT INTO public.model_invocations (id, tenant_id, agent_run_id, task_type, provider, model, status)
           VALUES (gen_random_uuid(), $1, $2, 'reason', 'mock', 'mock-model', 'succeeded')`,
          [tenantA, runB]
        );
      } catch (e) {
        err = e;
      }
      expect(pgErrorCode(err)).toBe("23503");
      expect(pgConstraint(err)).toBe("model_invocations_tenant_agent_run_fkey");
    });
  });

  it("outcomes.agent_run_id: an agent_run from a different tenant is rejected by outcomes_tenant_agent_run_fkey", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      const agentB = await insertAgent(client, tenantB);
      const runB = await insertAgentRun(client, tenantB, agentB);

      let err: unknown;
      try {
        await client.query(
          `INSERT INTO public.outcomes (id, tenant_id, agent_run_id, outcome_type, attribution_confidence)
           VALUES (gen_random_uuid(), $1, $2, 'admin_time_saved', 'direct')`,
          [tenantA, runB]
        );
      } catch (e) {
        err = e;
      }
      expect(pgErrorCode(err)).toBe("23503");
      expect(pgConstraint(err)).toBe("outcomes_tenant_agent_run_fkey");
    });
  });

  it("a same-tenant reference (the legitimate case) is NOT rejected by any composite FK", async () => {
    await withRollback(async (client) => {
      const tenant = await insertTenant(client);
      const agent = await insertAgent(client, tenant);
      const run = await insertAgentRun(client, tenant, agent);
      const approval = await insertApproval(client, tenant, agent, run);

      // No throw expected for any of these — same-tenant references throughout.
      await client.query(
        `INSERT INTO public.tool_calls (id, tenant_id, agent_run_id, tool_name, action, policy_snapshot, approval_id)
         VALUES (gen_random_uuid(), $1, $2, 'ping', 'execute', '{}'::jsonb, $3)`,
        [tenant, run, approval]
      );
      await client.query(
        `INSERT INTO public.model_invocations (id, tenant_id, agent_run_id, task_type, provider, model, status)
         VALUES (gen_random_uuid(), $1, $2, 'reason', 'mock', 'mock-model', 'succeeded')`,
        [tenant, run]
      );
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.tool_calls WHERE agent_run_id = $1`, [run]);
      expect(rows[0].n).toBe(1);
    });
  });

  it("deleting a business_event nulls only agent_runs.trigger_event_id, never agent_runs.tenant_id (column-scoped ON DELETE SET NULL)", async () => {
    await withRollback(async (client) => {
      const tenant = await insertTenant(client);
      const agent = await insertAgent(client, tenant);
      const event = await insertBusinessEvent(client, tenant);
      const run = await insertAgentRun(client, tenant, agent, { triggerEventId: event });

      await client.query(`DELETE FROM public.business_events WHERE id = $1`, [event]);

      const { rows } = await client.query(`SELECT tenant_id, trigger_event_id FROM public.agent_runs WHERE id = $1`, [run]);
      expect(rows[0].trigger_event_id).toBeNull();
      expect(rows[0].tenant_id).toBe(tenant);
    });
  });

  it("tool_calls.approval_id: a second tool_call cannot reference the same approval (tool_calls_approval_id_key)", async () => {
    await withRollback(async (client) => {
      const tenant = await insertTenant(client);
      const agent = await insertAgent(client, tenant);
      const run = await insertAgentRun(client, tenant, agent);
      const approval = await insertApproval(client, tenant, agent, run);

      await client.query(
        `INSERT INTO public.tool_calls (id, tenant_id, agent_run_id, tool_name, action, policy_snapshot, approval_id)
         VALUES (gen_random_uuid(), $1, $2, 'ping', 'execute', '{}'::jsonb, $3)`,
        [tenant, run, approval]
      );

      let err: unknown;
      try {
        await client.query(
          `INSERT INTO public.tool_calls (id, tenant_id, agent_run_id, tool_name, action, policy_snapshot, approval_id)
           VALUES (gen_random_uuid(), $1, $2, 'ping', 'execute', '{}'::jsonb, $3)`,
          [tenant, run, approval]
        );
      } catch (e) {
        err = e;
      }
      expect(pgErrorCode(err)).toBe("23505");
      expect(pgConstraint(err)).toBe("tool_calls_approval_id_key");
    });
  });

  it("agents: a second non-custom agent of the same agent_type for the same tenant is rejected by uq_agents_tenant_builtin_type", async () => {
    await withRollback(async (client) => {
      const tenant = await insertTenant(client);
      await insertAgent(client, tenant, { agentType: "dev_test" });

      let err: unknown;
      try {
        await insertAgent(client, tenant, { agentType: "dev_test" });
      } catch (e) {
        err = e;
      }
      expect(pgErrorCode(err)).toBe("23505");
      expect(pgConstraint(err)).toBe("uq_agents_tenant_builtin_type");
    });
  });

  it("agents: a second 'custom' agent for the same tenant is NOT rejected (uq_agents_tenant_builtin_type excludes 'custom')", async () => {
    await withRollback(async (client) => {
      const tenant = await insertTenant(client);
      await insertAgent(client, tenant, { agentType: "custom", name: "Custom 1" });
      // Must not throw.
      await insertAgent(client, tenant, { agentType: "custom", name: "Custom 2" });

      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.agents WHERE tenant_id = $1 AND agent_type = 'custom'`, [tenant]);
      expect(rows[0].n).toBe(2);
    });
  });
});
