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
 * Safe to run repeatedly (including against production) — it only creates
 * rows that don't already exist for the tenant.
 */
export async function seedAgents(tenantId: string, store: AgentStore = new SupabaseAgentStore()): Promise<{ devTest: Agent; supervisor: Agent }> {
  const existing = await store.listByTenant(tenantId);

  let devTest = existing.find((a) => a.agentType === "dev_test");
  if (!devTest) {
    devTest = await store.create({
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
  }

  let supervisor = existing.find((a) => a.agentType === "supervisor");
  if (!supervisor) {
    supervisor = await store.create({
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
  }

  return { devTest, supervisor };
}
