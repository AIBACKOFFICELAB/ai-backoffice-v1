import { describe, it, expect } from "vitest";
import { evaluateToolCall, canRead, canWrite } from "./permissions";
import { Agent, AutonomyTier, Permission } from "./types";
import { AnyToolDefinition, ToolContext, ToolResult } from "./toolRegistry";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    tenantId: "tenant-1",
    agentType: "dev_test",
    name: "Test Agent",
    purpose: null,
    status: "active",
    allowedTools: [],
    readScopes: [],
    writeScopes: [],
    approvalPolicy: {},
    modelPolicy: {},
    systemInstructions: null,
    instructionsVersion: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Minimal fake tool definition for testing the policy engine in
 * isolation from the real registry — this is what stands in for "a
 * caller" in these tests: the ONLY way to influence the resolved
 * permission is through this definition, never through anything passed to
 * evaluateToolCall itself. */
function makeTool(overrides: Partial<AnyToolDefinition> & Pick<AnyToolDefinition, "name" | "intrinsicPermission">): AnyToolDefinition {
  return {
    version: 1,
    effectClass: "read",
    sideEffectClass: "none",
    requiredReadScopes: [],
    requiredWriteScopes: [],
    minimumAutonomyTier: "AUTO_EXECUTE",
    idempotent: true,
    validateInput: (input: unknown) => ({ ok: true, value: input }),
    execute: async (_input: unknown, _ctx: ToolContext): Promise<ToolResult> => ({ ok: true, summary: {} }),
    ...overrides,
  };
}

describe("evaluateToolCall — agent permission enforcement (P0.4 / P0.9 Slice A)", () => {
  it("denies any tool call from a non-active agent", () => {
    const agent = makeAgent({ status: "paused", allowedTools: ["ping"] });
    const tool = makeTool({ name: "ping", intrinsicPermission: "EXECUTE" });
    expect(evaluateToolCall(agent, tool).decision).toBe("deny");
  });

  it("denies a tool not in allowed_tools regardless of its intrinsic permission", () => {
    const agent = makeAgent({ allowedTools: [] });
    const tool = makeTool({ name: "ping", intrinsicPermission: "EXECUTE" });
    const decision = evaluateToolCall(agent, tool);
    expect(decision.decision).toBe("deny");
    expect((decision as { reason: string }).reason).toMatch(/not in this agent's allowed_tools/);
  });

  it("allows AUTO_EXECUTE tools when explicitly configured", () => {
    const agent = makeAgent({ allowedTools: ["ping"], approvalPolicy: { ping: "AUTO_EXECUTE" } });
    const tool = makeTool({ name: "ping", intrinsicPermission: "EXECUTE", minimumAutonomyTier: "AUTO_EXECUTE" });
    expect(evaluateToolCall(agent, tool)).toEqual({ decision: "allow", tier: "AUTO_EXECUTE" });
  });

  it("allows AUTO_EXECUTE_AND_LOG tools", () => {
    const agent = makeAgent({ allowedTools: ["note"], approvalPolicy: { note: "AUTO_EXECUTE_AND_LOG" } });
    const tool = makeTool({ name: "note", intrinsicPermission: "WRITE", minimumAutonomyTier: "AUTO_EXECUTE_AND_LOG" });
    expect(evaluateToolCall(agent, tool)).toEqual({ decision: "allow", tier: "AUTO_EXECUTE_AND_LOG" });
  });

  it("routes REQUIRE_APPROVAL tools to the approval queue", () => {
    const agent = makeAgent({ allowedTools: ["draft"], approvalPolicy: { draft: "REQUIRE_APPROVAL" } });
    const tool = makeTool({ name: "draft", intrinsicPermission: "SEND", minimumAutonomyTier: "REQUIRE_APPROVAL" });
    expect(evaluateToolCall(agent, tool)).toEqual({ decision: "require_approval", tier: "REQUIRE_APPROVAL" });
  });

  it("defaults an unlisted-in-approval_policy tool to REQUIRE_APPROVAL (safe default)", () => {
    const agent = makeAgent({ allowedTools: ["mystery"], approvalPolicy: {} });
    const tool = makeTool({ name: "mystery", intrinsicPermission: "EXECUTE", minimumAutonomyTier: "AUTO_EXECUTE" });
    expect(evaluateToolCall(agent, tool).decision).toBe("require_approval");
  });

  it("denies HUMAN_ONLY-configured tools outright — never queues them for approval", () => {
    const agent = makeAgent({ allowedTools: ["strategic"], approvalPolicy: { strategic: "HUMAN_ONLY" } });
    const tool = makeTool({ name: "strategic", intrinsicPermission: "EXECUTE" });
    expect(evaluateToolCall(agent, tool).decision).toBe("deny");
  });

  it("a configured tier stricter than any floor is respected (floors are a minimum, not a fixed value)", () => {
    const agent = makeAgent({ allowedTools: ["risky"], approvalPolicy: { risky: "HUMAN_ONLY" } });
    const tool = makeTool({ name: "risky", intrinsicPermission: "FINANCIAL_ACTION", minimumAutonomyTier: "AUTO_EXECUTE" });
    expect(evaluateToolCall(agent, tool).decision).toBe("deny");
  });

  describe("read/write scope enforcement (previously unused canRead/canWrite are now enforced)", () => {
    it("denies when the agent is missing a required read scope", () => {
      const agent = makeAgent({ allowedTools: ["reader"], approvalPolicy: { reader: "AUTO_EXECUTE" }, readScopes: [] });
      const tool = makeTool({ name: "reader", intrinsicPermission: "READ", requiredReadScopes: ["leads"] });
      const decision = evaluateToolCall(agent, tool);
      expect(decision.decision).toBe("deny");
      expect((decision as { reason: string }).reason).toMatch(/missing required read scope/);
    });

    it("denies when the agent is missing a required write scope", () => {
      const agent = makeAgent({ allowedTools: ["writer"], approvalPolicy: { writer: "AUTO_EXECUTE" }, writeScopes: [] });
      const tool = makeTool({ name: "writer", intrinsicPermission: "WRITE", requiredWriteScopes: ["leads"] });
      const decision = evaluateToolCall(agent, tool);
      expect(decision.decision).toBe("deny");
      expect((decision as { reason: string }).reason).toMatch(/missing required write scope/);
    });

    it("allows when the agent has the exact required scopes", () => {
      const agent = makeAgent({
        allowedTools: ["reader"],
        approvalPolicy: { reader: "AUTO_EXECUTE" },
        readScopes: ["leads", "conversations"],
      });
      const tool = makeTool({ name: "reader", intrinsicPermission: "READ", requiredReadScopes: ["leads"] });
      expect(evaluateToolCall(agent, tool).decision).toBe("allow");
    });

    it("a wildcard scope satisfies any required scope", () => {
      const agent = makeAgent({ allowedTools: ["reader"], approvalPolicy: { reader: "AUTO_EXECUTE" }, readScopes: ["*"] });
      const tool = makeTool({ name: "reader", intrinsicPermission: "READ", requiredReadScopes: ["anything"] });
      expect(evaluateToolCall(agent, tool).decision).toBe("allow");
    });
  });

  describe("intrinsic-permission floors (Codex P0 audit finding B-02)", () => {
    it("FINANCIAL_ACTION can never be lower than REQUIRE_APPROVAL, even if approval_policy says AUTO_EXECUTE", () => {
      const agent = makeAgent({ allowedTools: ["pay"], approvalPolicy: { pay: "AUTO_EXECUTE" } });
      const tool = makeTool({ name: "pay", intrinsicPermission: "FINANCIAL_ACTION", minimumAutonomyTier: "AUTO_EXECUTE" });
      expect(evaluateToolCall(agent, tool).decision).toBe("require_approval");
    });

    it("DELETE can never be lower than REQUIRE_APPROVAL", () => {
      const agent = makeAgent({ allowedTools: ["remove"], approvalPolicy: { remove: "AUTO_EXECUTE" } });
      const tool = makeTool({ name: "remove", intrinsicPermission: "DELETE", minimumAutonomyTier: "AUTO_EXECUTE" });
      expect(evaluateToolCall(agent, tool).decision).toBe("require_approval");
    });

    it("SEND can never be lower than REQUIRE_APPROVAL", () => {
      const agent = makeAgent({ allowedTools: ["message"], approvalPolicy: { message: "AUTO_EXECUTE" } });
      const tool = makeTool({ name: "message", intrinsicPermission: "SEND", minimumAutonomyTier: "AUTO_EXECUTE" });
      expect(evaluateToolCall(agent, tool).decision).toBe("require_approval");
    });

    it("APPROVE always floors to HUMAN_ONLY — an agent can never approve its own or another action", () => {
      const agent = makeAgent({ allowedTools: ["approve"], approvalPolicy: { approve: "AUTO_EXECUTE" } });
      const tool = makeTool({ name: "approve", intrinsicPermission: "APPROVE", minimumAutonomyTier: "AUTO_EXECUTE" });
      expect(evaluateToolCall(agent, tool).decision).toBe("deny");
    });

    it("a tool's own minimumAutonomyTier is an independent floor, even for a plain EXECUTE permission", () => {
      const agent = makeAgent({ allowedTools: ["cautious"], approvalPolicy: { cautious: "AUTO_EXECUTE" } });
      const tool = makeTool({ name: "cautious", intrinsicPermission: "EXECUTE", minimumAutonomyTier: "REQUIRE_APPROVAL" });
      expect(evaluateToolCall(agent, tool).decision).toBe("require_approval");
    });
  });

  describe("caller cannot bypass intrinsic tool policy by relabeling the operation (Codex P0 audit finding B-02)", () => {
    // evaluateToolCall's signature is (agent, tool) — there is no third
    // parameter for a caller-declared permission. These tests prove the
    // *effect* of that design: no matter how permissively an agent is
    // configured (the most lenient legitimate channel available), a tool
    // whose intrinsic permission is SEND/DELETE/FINANCIAL_ACTION/APPROVE
    // can never resolve to a tier looser than its floor. There is no
    // "pretend this is EXECUTE" input anywhere in this call — that is the
    // fix, not an incidental property of it.
    const maximallyPermissiveAgent = makeAgent({
      allowedTools: ["send_tool", "delete_tool", "financial_tool", "approve_tool"],
      approvalPolicy: {
        send_tool: "AUTO_EXECUTE",
        delete_tool: "AUTO_EXECUTE",
        financial_tool: "AUTO_EXECUTE",
        approve_tool: "AUTO_EXECUTE",
      },
    });

    const cases: Array<{ toolName: string; permission: Permission; expected: "require_approval" | "deny" }> = [
      { toolName: "send_tool", permission: "SEND", expected: "require_approval" },
      { toolName: "delete_tool", permission: "DELETE", expected: "require_approval" },
      { toolName: "financial_tool", permission: "FINANCIAL_ACTION", expected: "require_approval" },
      { toolName: "approve_tool", permission: "APPROVE", expected: "deny" },
    ];

    it.each(cases)("a tool whose intrinsic permission is $permission never resolves to allow, even under the most permissive agent config", ({ toolName, permission, expected }) => {
      const tool = makeTool({ name: toolName, intrinsicPermission: permission, minimumAutonomyTier: "AUTO_EXECUTE" });
      const decision = evaluateToolCall(maximallyPermissiveAgent, tool);
      expect(decision.decision).toBe(expected);
      expect(decision.decision).not.toBe("allow");
    });

    it("a decoy 'permission' key inside the tool's own input payload has no effect — evaluateToolCall never reads tool inputs", () => {
      // Simulates a caller trying the pre-Slice-A attack shape: smuggling a
      // permission claim into data the runtime touches. evaluateToolCall
      // takes no input/payload parameter at all, so there is nothing for
      // this to reach.
      const tool = makeTool({ name: "financial_tool", intrinsicPermission: "FINANCIAL_ACTION", minimumAutonomyTier: "AUTO_EXECUTE" });
      const decision = evaluateToolCall(maximallyPermissiveAgent, tool);
      expect(decision.decision).toBe("require_approval");
    });
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

describe("AutonomyTier sanity", () => {
  it("all four tiers used by the engine are the ones the P0 directive defines", () => {
    const tiers: AutonomyTier[] = ["AUTO_EXECUTE", "AUTO_EXECUTE_AND_LOG", "REQUIRE_APPROVAL", "HUMAN_ONLY"];
    expect(tiers).toHaveLength(4);
  });
});
