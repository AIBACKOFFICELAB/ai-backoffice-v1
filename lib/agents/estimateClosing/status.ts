import { Agent } from "../types";

/**
 * P1 Sprint 2 — one honest tri-state, not a boolean, so the UI (dashboard
 * and /agentic both use this) can tell apart "never configured for this
 * account" from "configured but the owner hasn't turned it on yet."
 * Extracted into its own pure function so both pages derive it identically
 * instead of duplicating (and risking drifting) the same five lines.
 */
export type EstimateClosingAgentStatus = "not_registered" | "inactive" | "active";

export function resolveEstimateClosingAgentStatus(agents: Array<Pick<Agent, "agentType" | "status">>): EstimateClosingAgentStatus {
  const agent = agents.find((a) => a.agentType === "estimate_closing");
  if (!agent) return "not_registered";
  return agent.status === "active" ? "active" : "inactive";
}
