import { Agent } from "../types";
import { AgentStore, SupabaseAgentStore } from "../agentStore";

/**
 * P1 Sprint 2 — dedicated, idempotent registration for the Estimate
 * Closing Agent, deliberately separate from lib/agents/seed.ts::seedAgents.
 *
 * seedAgents() is P0-oriented: it creates BOTH a dev_test agent (active,
 * with tools) and a supervisor placeholder as a pair, for proving the
 * runtime end-to-end. Making production Estimate Closing activation depend
 * on calling that function would mean the only path to registering this
 * agent also creates/touches two unrelated agent rows that have nothing to
 * do with Estimate Closing — this function exists so registration can
 * happen without any side effect on dev_test/supervisor at all.
 *
 * Concurrency-safe the same way seedAgents/createIfAbsent already are
 * (Codex P0 audit finding M-03): relies on AgentStore.createIfAbsent, which
 * is backed by the database's uq_agents_tenant_builtin_type uniqueness
 * constraint (migration 017) as the actual guarantee, not a list-then-
 * insert check. Two concurrent calls for the same tenant produce exactly
 * one row.
 *
 * Deliberately minimal — this registers the row INACTIVE and with zero
 * capability. It never activates the agent, never sets
 * ESTIMATE_CLOSING_SHADOW_ENABLED, and is never called from a page render
 * (see the "no hidden activation" requirement in the P1 Sprint 2
 * directive). The full activation procedure — this call, then an explicit
 * status change to 'active', then the environment variable — is documented
 * in featureFlag.ts.
 *
 * allowedTools/writeScopes/approvalPolicy are all empty by construction:
 * shadowRunner.ts (the only code path that ever invokes this agent) has no
 * `toolPlan` parameter anywhere in its signature and never imports
 * lib/agents/toolRegistry.ts or the tool-call/approval runtime — there is
 * structurally nothing for a tool/write/approval grant on this row to
 * authorize. readScopes/modelPolicy are set to values that describe what
 * the shadow path genuinely reads/does today (estimate_followup_sequences
 * + leads via stalledScan.ts's SupabaseSequenceWithLeadReader; "medium"
 * complexity via shadowRunner.ts's own ai.generateStructured call) —
 * documentary metadata for audit purposes, not an enforcement mechanism
 * shadowRunner.ts consults (it re-verifies agent.status itself, the same
 * way every other invocation path in this codebase does — see
 * shadowRunner.ts's own doc comment).
 *
 * Takes only Pick<AgentStore, "createIfAbsent">, not the full AgentStore,
 * deliberately: the one caller outside a Next.js request context (the
 * operator registration script — see
 * scripts/register-estimate-closing-agent.ts) has no access to
 * next/headers-based cookies() and so cannot construct a real
 * SupabaseAgentStore; narrowing to the single method this function
 * actually calls lets that script satisfy the type with a minimal adapter
 * instead of implementing the entire interface.
 */
export async function ensureEstimateClosingAgent(
  tenantId: string,
  store: Pick<AgentStore, "createIfAbsent"> = new SupabaseAgentStore()
): Promise<{ agent: Agent; created: boolean }> {
  return store.createIfAbsent({
    tenantId,
    agentType: "estimate_closing",
    name: "Estimate Closing Agent",
    purpose:
      "Analyzes stalled estimates (no reply since the automated Day 1/3/7 follow-up sequence completed) and produces a structured, privacy-safe recommendation in Shadow Mode. Cannot contact a customer, change lead/estimate state, or execute any tool.",
    status: "inactive",
    allowedTools: [],
    readScopes: ["leads", "estimate_followup_sequences"],
    writeScopes: [],
    approvalPolicy: {},
    modelPolicy: {
      reason: { complexity: "medium" },
    },
    systemInstructions: null,
  });
}
