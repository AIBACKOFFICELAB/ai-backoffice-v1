import { describe, it, expect } from "vitest";
import { pingTool, createInternalNoteTool, draftCustomerMessageTool, DEFAULT_TOOL_REGISTRY } from "./toolRegistry";

describe("tool definitions own their security metadata (Codex P0 audit finding B-02)", () => {
  it("ping: EXECUTE, no floor beyond AUTO_EXECUTE, no scopes required", () => {
    expect(pingTool.intrinsicPermission).toBe("EXECUTE");
    expect(pingTool.minimumAutonomyTier).toBe("AUTO_EXECUTE");
    expect(pingTool.requiredReadScopes).toEqual([]);
    expect(pingTool.requiredWriteScopes).toEqual([]);
    expect(pingTool.sideEffectClass).toBe("none");
  });

  it("create_internal_note: WRITE, floored at AUTO_EXECUTE_AND_LOG, internal-only side effect", () => {
    expect(createInternalNoteTool.intrinsicPermission).toBe("WRITE");
    expect(createInternalNoteTool.minimumAutonomyTier).toBe("AUTO_EXECUTE_AND_LOG");
    expect(createInternalNoteTool.sideEffectClass).toBe("internal_only");
  });

  it("draft_customer_message: SEND, floored at REQUIRE_APPROVAL, customer-facing side effect", () => {
    expect(draftCustomerMessageTool.intrinsicPermission).toBe("SEND");
    expect(draftCustomerMessageTool.minimumAutonomyTier).toBe("REQUIRE_APPROVAL");
    expect(draftCustomerMessageTool.sideEffectClass).toBe("customer_facing");
  });

  it("every default tool carries a definition version", () => {
    for (const tool of Object.values(DEFAULT_TOOL_REGISTRY)) {
      expect(typeof tool.version).toBe("number");
      expect(tool.version).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("validateInput — a malformed request never reaches execute() or an approval", () => {
  it("ping accepts any object, including {}", () => {
    expect(pingTool.validateInput({})).toEqual({ ok: true, value: {} });
    expect(pingTool.validateInput({ anything: 1 })).toEqual({ ok: true, value: { anything: 1 } });
  });

  it("ping normalizes non-object input to {}", () => {
    expect(pingTool.validateInput("not an object")).toEqual({ ok: true, value: {} });
    expect(pingTool.validateInput(null)).toEqual({ ok: true, value: {} });
  });

  it("create_internal_note requires a non-empty string note", () => {
    expect(createInternalNoteTool.validateInput({ note: "hello" })).toEqual({ ok: true, value: { note: "hello" } });
    expect(createInternalNoteTool.validateInput({ note: "" }).ok).toBe(false);
    expect(createInternalNoteTool.validateInput({}).ok).toBe(false);
    expect(createInternalNoteTool.validateInput({ note: 42 }).ok).toBe(false);
    expect(createInternalNoteTool.validateInput(null).ok).toBe(false);
  });

  it("draft_customer_message requires a string draft (empty string is a valid draft-in-progress)", () => {
    expect(draftCustomerMessageTool.validateInput({ draft: "Hi there" })).toEqual({ ok: true, value: { draft: "Hi there" } });
    expect(draftCustomerMessageTool.validateInput({ draft: "" })).toEqual({ ok: true, value: { draft: "" } });
    expect(draftCustomerMessageTool.validateInput({}).ok).toBe(false);
    expect(draftCustomerMessageTool.validateInput({ draft: 1 }).ok).toBe(false);
  });
});

/**
 * validateOutput (P0.9 Slice B, finding B-09) — enforced by the runtime
 * (lib/agents/runtime.ts::executeToolDefinition), unit-tested here in
 * isolation for the contract itself.
 */
describe("validateOutput — a malformed tool response is detectable", () => {
  it("ping's real execute() output always passes its own validateOutput", async () => {
    const result = await pingTool.execute({}, { tenantId: "t1", agentRunId: "run-1" });
    expect(pingTool.validateOutput!(result.summary)).toEqual({ ok: true });
  });

  it("ping's validateOutput rejects a response missing pong: true", () => {
    expect(pingTool.validateOutput!({})).toMatchObject({ ok: false });
    expect(pingTool.validateOutput!({ pong: false })).toMatchObject({ ok: false });
    expect(pingTool.validateOutput!(null)).toMatchObject({ ok: false });
  });
});
