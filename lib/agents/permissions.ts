import { Agent, AutonomyTier, Permission } from "./types";
import { AnyToolDefinition } from "./toolRegistry";

/**
 * The agent permission/policy engine (P0.4, hardened P0.9 Slice A per Codex
 * audit finding B-02). Pure functions, no I/O — every decision here must be
 * reconstructable from an agent's row and a registered ToolDefinition alone,
 * which is what makes it independently unit-testable
 * (lib/agents/permissions.test.ts) and auditable (agent_runs/tool_calls
 * record which decision was made, not just the outcome). See
 * docs/AGENT_SECURITY.md.
 *
 * SECURITY INVARIANT: evaluateToolCall takes a registered ToolDefinition,
 * never a caller-declared permission. There is no parameter on this
 * function — or on lib/agents/runtime.ts's PlannedToolCall — through which
 * a caller can omit, forge, or downgrade the permission a tool call is
 * evaluated under. Permission is read exclusively from
 * `tool.intrinsicPermission`, which only a tool's own definition sets.
 */

export type PolicyDecision =
  | { decision: "allow"; tier: AutonomyTier }
  | { decision: "deny"; reason: string }
  | { decision: "require_approval"; tier: AutonomyTier };

/**
 * Permissions that can never be satisfied by a tier lower than the floor
 * here, regardless of what an agent's approval_policy says — a
 * misconfigured AUTO_EXECUTE entry for a financial, destructive, or
 * customer-facing-send action cannot silently grant autonomy the directive
 * says must be earned. APPROVE has no floor exemption at all: an agent can
 * never approve its own (or another agent's) action — see
 * docs/AGENT_SECURITY.md "Who can approve."
 */
const PERMISSION_FLOOR: Partial<Record<Permission, AutonomyTier>> = {
  SEND: "REQUIRE_APPROVAL",
  DELETE: "REQUIRE_APPROVAL",
  FINANCIAL_ACTION: "REQUIRE_APPROVAL",
  APPROVE: "HUMAN_ONLY",
};

const TIER_RANK: Record<AutonomyTier, number> = {
  AUTO_EXECUTE: 0,
  AUTO_EXECUTE_AND_LOG: 1,
  REQUIRE_APPROVAL: 2,
  HUMAN_ONLY: 3,
};

function stricter(a: AutonomyTier, b: AutonomyTier): AutonomyTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * Resolves the tier a tool call actually runs at by combining three floors
 * and taking the strictest:
 *   1. agent.approval_policy[tool.name] (or REQUIRE_APPROVAL if unset — an
 *      action nobody explicitly graded never silently auto-executes)
 *   2. PERMISSION_FLOOR[tool.intrinsicPermission]
 *   3. tool.minimumAutonomyTier (the tool's own declared floor)
 * A looser value in any one of these can never override a stricter value
 * in another.
 */
function resolveTier(agent: Agent, tool: AnyToolDefinition): AutonomyTier {
  const configured = agent.approvalPolicy[tool.name] ?? "REQUIRE_APPROVAL";
  const permissionFloor = PERMISSION_FLOOR[tool.intrinsicPermission] ?? "AUTO_EXECUTE";
  return stricter(stricter(configured, permissionFloor), tool.minimumAutonomyTier);
}

/**
 * The single entry point the agent runtime calls before invoking any tool.
 * An agent that isn't 'active', isn't allow-listed for the tool, is missing
 * a required read/write scope, or whose resolved tier is HUMAN_ONLY is
 * denied outright — HUMAN_ONLY never even reaches the approval queue,
 * because it means a human must act directly, not "agent proposes, human
 * approves."
 */
export function evaluateToolCall(agent: Agent, tool: AnyToolDefinition): PolicyDecision {
  if (agent.status !== "active") {
    return { decision: "deny", reason: `agent status is '${agent.status}', not 'active'` };
  }

  if (!agent.allowedTools.includes(tool.name)) {
    return { decision: "deny", reason: `tool '${tool.name}' is not in this agent's allowed_tools` };
  }

  const missingRead = tool.requiredReadScopes.filter((scope) => !canRead(agent, scope));
  if (missingRead.length > 0) {
    return { decision: "deny", reason: `agent is missing required read scope(s): ${missingRead.join(", ")}` };
  }

  const missingWrite = tool.requiredWriteScopes.filter((scope) => !canWrite(agent, scope));
  if (missingWrite.length > 0) {
    return { decision: "deny", reason: `agent is missing required write scope(s): ${missingWrite.join(", ")}` };
  }

  const tier = resolveTier(agent, tool);

  if (tier === "HUMAN_ONLY") {
    return { decision: "deny", reason: `'${tool.name}' is HUMAN_ONLY — an agent may never execute this or request approval for it` };
  }

  if (tier === "REQUIRE_APPROVAL") {
    return { decision: "require_approval", tier };
  }

  return { decision: "allow", tier };
}

export function canRead(agent: Agent, scope: string): boolean {
  return agent.readScopes.includes(scope) || agent.readScopes.includes("*");
}

export function canWrite(agent: Agent, scope: string): boolean {
  return agent.writeScopes.includes(scope) || agent.writeScopes.includes("*");
}
