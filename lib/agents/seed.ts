import { Agent } from "./types";
import { AgentStore, SupabaseAgentStore } from "./agentStore";

/**
 * Idempotently ensures the two P0 prototype agents exist for a tenant:
 *
 * - 'dev_test': proves the runtime end-to-end. Active, and only ever
 *   configured with the safe/mock tools in lib/agents/toolRegistry.ts — it
 *   is never wired to a production trigger and never touches customer data.
 * - 'supervisor': a placeholder row proving the registry/schema supports the
 *   eventual Supervisor Agent (see docs/AGENTIC_ROADMAP.md). Left 'inactive'
 *   — P0 proves the runtime can run an agent, it does not ship a real
 *   supervisor.
 *
 * Concurrency-safe (Codex P0 audit finding M-03): uses
 * AgentStore.createIfAbsent, which relies on the database's
 * uq_agents_tenant_builtin_type uniqueness constraint (migration 017) as
 * the actual guarantee — not a list-then-insert check, which has an
 * inherent race between the list and the insert. Two concurrent calls to
 * this function for the same tenant produce exactly one dev_test row and
 * exactly one supervisor row; see lib/agents/seed.test.ts.
 */
export async function seedAgents(tenantId: string, store: AgentStore = new SupabaseAgentStore()): Promise<{ devTest: Agent; supervisor: Agent }> {
  const { agent: devTest } = await store.createIfAbsent({
    tenantId,
    agentType: "dev_test",
    name: "Dev/Test Agent",
    purpose: "Proves the agent runtime end-to-end (P0 exit criteria). Never wired to a production trigger.",
    status: "active",
    allowedTools: ["ping", "create_internal_note", "draft_customer_message"],
    readScopes: ["business_events"],
    writeScopes: [],
    approvalPolicy: {
      ping: "AUTO_EXECUTE",
      create_internal_note: "AUTO_EXECUTE_AND_LOG",
      draft_customer_message: "REQUIRE_APPROVAL",
    },
    modelPolicy: {
      reason: { complexity: "low", costPreference: "low" },
    },
    systemInstructions: "You are a diagnostic agent used only to verify the AI BackOffice agent runtime is working correctly.",
  });

  const { agent: supervisor } = await store.createIfAbsent({
    tenantId,
    agentType: "supervisor",
    name: "Supervisor (prototype)",
    purpose: "Placeholder proving the schema/registry support the eventual Supervisor Agent. Not wired to any trigger.",
    status: "inactive",
    allowedTools: [],
    readScopes: [],
    writeScopes: [],
    approvalPolicy: {},
    modelPolicy: {},
    systemInstructions: null,
  });

  return { devTest, supervisor };
}
