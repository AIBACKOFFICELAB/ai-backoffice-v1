import { Agent, AutonomyTier, Permission } from "./types";

/**
 * The agent permission/policy engine (P0.4). Pure functions, no I/O — every
 * decision here must be reconstructable from an agent's row alone, which is
 * what makes it independently unit-testable (see lib/agents/permissions.test.ts)
 * and auditable (the agent_runs/tool_calls rows record which decision was
 * made, not just the outcome). See docs/AGENT_SECURITY.md.
 */

export type PolicyDecision =
  | { decision: "allow"; tier: AutonomyTier }
  | { decision: "deny"; reason: string }
  | { decision: "require_approval"; tier: AutonomyTier };

/**
 * Permissions that can never be satisfied by a tier lower than the floor
 * here, regardless of what an agent's approval_policy says — a
 * misconfigured AUTO_EXECUTE entry for a financial or destructive action
 * cannot silently grant autonomy the directive says must be earned.
 * APPROVE has no floor exemption at all: an agent can never approve its own
 * (or another agent's) action — see docs/AGENT_SECURITY.md "Who can approve."
 */
const PERMISSION_FLOOR: Partial<Record<Permission, AutonomyTier>> = {
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

function resolveTier(agent: Agent, toolName: string, permission: Permission): AutonomyTier {
  // Safe default: an action nobody explicitly graded requires approval, it
  // never silently auto-executes.
  const configured = agent.approvalPolicy[toolName] ?? "REQUIRE_APPROVAL";
  const floor = PERMISSION_FLOOR[permission];
  if (floor && TIER_RANK[floor] > TIER_RANK[configured]) return floor;
  return configured;
}

export type ToolCallRequest = {
  toolName: string;
  /** Defaults to EXECUTE. Pass DELETE/FINANCIAL_ACTION/APPROVE explicitly
   * when the tool call represents one of those — this is what activates the
   * hard floor above. */
  permission?: Permission;
};

/**
 * The single entry point the agent runtime calls before invoking any tool.
 * An agent that isn't 'active', isn't allow-listed for the tool, or whose
 * resolved tier is HUMAN_ONLY is denied outright — it never even reaches the
 * approval queue for that case, because HUMAN_ONLY means a human must act
 * directly, not "agent proposes, human approves."
 */
export function evaluateToolCall(agent: Agent, call: ToolCallRequest): PolicyDecision {
  const permission = call.permission ?? "EXECUTE";

  if (agent.status !== "active") {
    return { decision: "deny", reason: `agent status is '${agent.status}', not 'active'` };
  }

  if (!agent.allowedTools.includes(call.toolName)) {
    return { decision: "deny", reason: `tool '${call.toolName}' is not in this agent's allowed_tools` };
  }

  const tier = resolveTier(agent, call.toolName, permission);

  if (tier === "HUMAN_ONLY") {
    return { decision: "deny", reason: `'${call.toolName}' is HUMAN_ONLY — an agent may never execute this or request approval for it` };
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
