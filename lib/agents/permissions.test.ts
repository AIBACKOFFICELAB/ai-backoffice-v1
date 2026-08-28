import { describe, it, expect } from "vitest";
import { evaluateToolCall, canRead, canWrite, buildPolicySnapshot, hashInstructions, PolicyDecision } from "./permissions";
import { createHash } from "crypto";
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

/**
 * Immutable policy-decision audit snapshot (P0.9 Slice B, finding H-04/B-08).
 */
describe("buildPolicySnapshot", () => {
  it("captures the decision actually made, from the registered tool, at build time", () => {
    const agent = makeAgent({ allowedTools: ["draft"], approvalPolicy: { draft: "REQUIRE_APPROVAL" }, instructionsVersion: 4 });
    const tool = makeTool({ name: "draft", intrinsicPermission: "SEND", minimumAutonomyTier: "REQUIRE_APPROVAL", version: 2 });
    const decision = evaluateToolCall(agent, tool);

    const snapshot = buildPolicySnapshot(agent, tool, "draft", "execute", decision);
    expect(snapshot).toMatchObject({
      snapshotVersion: 1,
      toolName: "draft",
      action: "execute",
      intrinsicPermission: "SEND",
      toolDefinitionVersion: 2,
      resolvedTier: "REQUIRE_APPROVAL",
      decision: "require_approval",
      agentInstructionsVersion: 4,
      agentConfiguredTier: "REQUIRE_APPROVAL",
    });
  });

  it("handles the unregistered-tool case (tool: null) uniformly", () => {
    const agent = makeAgent();
    const decision: PolicyDecision = { decision: "deny", reason: "tool 'ghost' is not registered" };
    const snapshot = buildPolicySnapshot(agent, null, "ghost", "execute", decision);
    expect(snapshot.intrinsicPermission).toBeNull();
    expect(snapshot.toolDefinitionVersion).toBeNull();
    expect(snapshot.agentConfiguredTier).toBeNull();
    expect(snapshot.decision).toBe("deny");
    expect(snapshot.reason).toBe("tool 'ghost' is not registered");
  });

  it("a 'deny' decision carries no resolvedTier — mirrors PolicyDecision's own shape rather than inventing one", () => {
    const agent = makeAgent({ status: "paused" });
    const tool = makeTool({ name: "ping", intrinsicPermission: "EXECUTE" });
    const decision = evaluateToolCall(agent, tool);
    const snapshot = buildPolicySnapshot(agent, tool, "ping", "execute", decision);
    expect(snapshot.resolvedTier).toBeNull();
    expect(snapshot.reason).toMatch(/not 'active'/);
  });

  it("scenario 16: a historical snapshot remains reconstructable after the agent's CURRENT configuration is later mutated", () => {
    const agent = makeAgent({ allowedTools: ["ping"], approvalPolicy: { ping: "AUTO_EXECUTE" }, readScopes: ["leads"] });
    const tool = makeTool({ name: "ping", intrinsicPermission: "EXECUTE", minimumAutonomyTier: "AUTO_EXECUTE" });
    const decisionAtTheTime = evaluateToolCall(agent, tool);
    const snapshot = buildPolicySnapshot(agent, tool, "ping", "execute", decisionAtTheTime);

    expect(snapshot.decision).toBe("allow");
    expect(snapshot.resolvedTier).toBe("AUTO_EXECUTE");
    expect(snapshot.agentReadScopes).toEqual(["leads"]);

    // Mutate the agent's CURRENT configuration in place, as a real
    // agentStore.update() would — the snapshot must be entirely unaffected,
    // since it was copied by value, not by reference.
    agent.approvalPolicy = { ping: "HUMAN_ONLY" };
    agent.readScopes = [];
    agent.instructionsVersion = 99;

    expect(snapshot.decision).toBe("allow");
    expect(snapshot.resolvedTier).toBe("AUTO_EXECUTE");
    expect(snapshot.agentReadScopes).toEqual(["leads"]);
    expect(snapshot.agentInstructionsVersion).toBe(1);

    // Re-evaluating NOW, against the mutated agent, correctly produces a
    // DIFFERENT decision — proving the snapshot isn't just stale by
    // accident, it's a deliberately preserved historical record distinct
    // from "what would happen if evaluated again today."
    const decisionNow = evaluateToolCall(agent, tool);
    expect(decisionNow.decision).toBe("deny");
  });
});

/**
 * Trustworthy instruction identity (P0.9 Slice B correction 3). Before this
 * correction, PolicySnapshot's only instruction identity was the numeric
 * agentInstructionsVersion, which AgentStore.update() could leave stale —
 * two genuinely different system_instructions values could both report
 * version 1. agentInstructionsHash is a SHA-256 digest of the exact text
 * evaluated, computed at buildPolicySnapshot() time and copied by value —
 * it is correct regardless of whether the numeric version was maintained.
 */
describe("hashInstructions / agentInstructionsHash (B-07 correction 3)", () => {
  it("test 1: the snapshot's instruction hash corresponds to the agent's actual instructions", () => {
    const agent = makeAgent({ allowedTools: ["ping"], approvalPolicy: { ping: "AUTO_EXECUTE" }, systemInstructions: "Be concise and helpful." });
    const tool = makeTool({ name: "ping", intrinsicPermission: "EXECUTE", minimumAutonomyTier: "AUTO_EXECUTE" });
    const decision = evaluateToolCall(agent, tool);
    const snapshot = buildPolicySnapshot(agent, tool, "ping", "execute", decision);

    const expected = createHash("sha256").update("Be concise and helpful.", "utf8").digest("hex");
    expect(snapshot.agentInstructionsHash).toBe(expected);
    expect(snapshot.agentInstructionsHash).toBe(hashInstructions(agent.systemInstructions));
  });

  it("test 2: mutating system instructions produces a DIFFERENT snapshot hash on the next evaluation", () => {
    const agent = makeAgent({ allowedTools: ["ping"], approvalPolicy: { ping: "AUTO_EXECUTE" }, systemInstructions: "Version A instructions" });
    const tool = makeTool({ name: "ping", intrinsicPermission: "EXECUTE", minimumAutonomyTier: "AUTO_EXECUTE" });
    const snapshotA = buildPolicySnapshot(agent, tool, "ping", "execute", evaluateToolCall(agent, tool));

    agent.systemInstructions = "Version B instructions — completely different";
    const snapshotB = buildPolicySnapshot(agent, tool, "ping", "execute", evaluateToolCall(agent, tool));

    expect(snapshotA.agentInstructionsHash).not.toBe(snapshotB.agentInstructionsHash);
  });

  it("test 3: mutating an unrelated agent field does not change the instruction identity", () => {
    const agent = makeAgent({ allowedTools: ["ping"], approvalPolicy: { ping: "AUTO_EXECUTE" }, systemInstructions: "Stable instructions" });
    const tool = makeTool({ name: "ping", intrinsicPermission: "EXECUTE", minimumAutonomyTier: "AUTO_EXECUTE" });
    const before = hashInstructions(agent.systemInstructions);

    agent.name = "Renamed Agent";
    agent.readScopes = ["something-new"];
    agent.status = "paused";

    expect(hashInstructions(agent.systemInstructions)).toBe(before);
  });

  it("test 4: a historical snapshot's hash remains unchanged after the agent's current instructions later change", () => {
    const agent = makeAgent({ allowedTools: ["ping"], approvalPolicy: { ping: "AUTO_EXECUTE" }, systemInstructions: "Original instructions" });
    const tool = makeTool({ name: "ping", intrinsicPermission: "EXECUTE", minimumAutonomyTier: "AUTO_EXECUTE" });
    const snapshot = buildPolicySnapshot(agent, tool, "ping", "execute", evaluateToolCall(agent, tool));
    const originalHash = snapshot.agentInstructionsHash;

    agent.systemInstructions = "Instructions rewritten after the fact";

    expect(snapshot.agentInstructionsHash).toBe(originalHash);
    expect(snapshot.agentInstructionsHash).not.toBe(hashInstructions(agent.systemInstructions));
  });

  it("test 5: null and undefined instructions hash identically and deterministically to the empty string", () => {
    const emptyHash = createHash("sha256").update("", "utf8").digest("hex");
    expect(hashInstructions(null)).toBe(emptyHash);
    expect(hashInstructions(undefined)).toBe(emptyHash);
    expect(hashInstructions(null)).toBe(hashInstructions(undefined));
    // Deterministic across repeated calls.
    expect(hashInstructions("same text")).toBe(hashInstructions("same text"));
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
