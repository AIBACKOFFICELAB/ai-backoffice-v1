import { describe, it, expect } from "vitest";
import { evaluateToolCall, canRead, canWrite } from "./permissions";
import { Agent } from "./types";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    tenantId: "tenant-1",
    agentType: "dev_test",
    name: "Test Agent",
    purpose: null,
    status: "active",
    allowedTools: ["ping", "create_internal_note", "draft_customer_message", "issue_refund", "approve_estimate"],
    readScopes: ["leads"],
    writeScopes: [],
    approvalPolicy: {
      ping: "AUTO_EXECUTE",
      create_internal_note: "AUTO_EXECUTE_AND_LOG",
      draft_customer_message: "REQUIRE_APPROVAL",
      issue_refund: "AUTO_EXECUTE", // deliberately misconfigured — the floor must still catch it
      approve_estimate: "AUTO_EXECUTE", // deliberately misconfigured APPROVE permission
    },
    modelPolicy: {},
    systemInstructions: null,
    instructionsVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("evaluateToolCall — agent permission enforcement (P0.4)", () => {
  it("denies any tool call from a non-active agent", () => {
    const agent = makeAgent({ status: "paused" });
    const decision = evaluateToolCall(agent, { toolName: "ping" });
    expect(decision.decision).toBe("deny");
  });

  it("denies a tool not in allowed_tools regardless of approval_policy", () => {
    const agent = makeAgent();
    const decision = evaluateToolCall(agent, { toolName: "send_wire_transfer" });
    expect(decision.decision).toBe("deny");
    expect((decision as { reason: string }).reason).toMatch(/not in this agent's allowed_tools/);
  });

  it("allows AUTO_EXECUTE tools", () => {
    const agent = makeAgent();
    expect(evaluateToolCall(agent, { toolName: "ping" })).toEqual({ decision: "allow", tier: "AUTO_EXECUTE" });
  });

  it("allows AUTO_EXECUTE_AND_LOG tools (still logged by the caller, not a special decision)", () => {
    const agent = makeAgent();
    expect(evaluateToolCall(agent, { toolName: "create_internal_note" })).toEqual({ decision: "allow", tier: "AUTO_EXECUTE_AND_LOG" });
  });

  it("routes REQUIRE_APPROVAL tools to the approval queue", () => {
    const agent = makeAgent();
    expect(evaluateToolCall(agent, { toolName: "draft_customer_message" })).toEqual({ decision: "require_approval", tier: "REQUIRE_APPROVAL" });
  });

  it("denies unlisted actions by default (safe default, never silently auto-executes)", () => {
    const agent = makeAgent({ allowedTools: ["mystery_tool"], approvalPolicy: {} });
    const decision = evaluateToolCall(agent, { toolName: "mystery_tool" });
    expect(decision.decision).toBe("require_approval");
  });

  it("denies HUMAN_ONLY actions outright — never queues them for approval", () => {
    const agent = makeAgent({ allowedTools: ["strategic_decision"], approvalPolicy: { strategic_decision: "HUMAN_ONLY" } });
    const decision = evaluateToolCall(agent, { toolName: "strategic_decision" });
    expect(decision.decision).toBe("deny");
  });

  it("FINANCIAL_ACTION can never be lower than REQUIRE_APPROVAL, even if approval_policy says AUTO_EXECUTE", () => {
    const agent = makeAgent();
    const decision = evaluateToolCall(agent, { toolName: "issue_refund", permission: "FINANCIAL_ACTION" });
    expect(decision.decision).toBe("require_approval");
  });

  it("DELETE can never be lower than REQUIRE_APPROVAL", () => {
    const agent = makeAgent({ allowedTools: ["delete_customer"], approvalPolicy: { delete_customer: "AUTO_EXECUTE" } });
    const decision = evaluateToolCall(agent, { toolName: "delete_customer", permission: "DELETE" });
    expect(decision.decision).toBe("require_approval");
  });

  it("APPROVE always floors to HUMAN_ONLY — an agent can never approve its own or another action", () => {
    const agent = makeAgent();
    const decision = evaluateToolCall(agent, { toolName: "approve_estimate", permission: "APPROVE" });
    expect(decision.decision).toBe("deny");
  });

  it("a configured tier stricter than the floor is respected (floors are a minimum, not a fixed value)", () => {
    const agent = makeAgent({ allowedTools: ["issue_refund"], approvalPolicy: { issue_refund: "HUMAN_ONLY" } });
    const decision = evaluateToolCall(agent, { toolName: "issue_refund", permission: "FINANCIAL_ACTION" });
    expect(decision.decision).toBe("deny");
  });
});

describe("canRead / canWrite", () => {
  it("checks explicit scopes and the '*' wildcard", () => {
    const agent = makeAgent({ readScopes: ["leads"], writeScopes: ["*"] });
    expect(canRead(agent, "leads")).toBe(true);
    expect(canRead(agent, "invoices")).toBe(false);
    expect(canWrite(agent, "anything")).toBe(true);
  });
});
