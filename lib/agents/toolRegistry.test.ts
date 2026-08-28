import { describe, it, expect } from "vitest";
import {
  pingTool,
  createInternalNoteTool,
  draftCustomerMessageTool,
  DEFAULT_TOOL_REGISTRY,
  conservativeAuditFallback,
  summarizeForAudit,
} from "./toolRegistry";

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

/**
 * Tool audit privacy fail-closed (P0.9 Slice C correction 2/2B):
 * conservativeAuditFallback and summarizeForAudit are the runtime-owned
 * defaults lib/agents/runtime.ts routes every audit summary through — a
 * tool that defines no summarizer, or whose summarizer throws/returns
 * something malformed, must NEVER cause a raw value to be persisted.
 */
describe("conservativeAuditFallback — bounded structural metadata only, never values", () => {
  const SENTINEL_PHONE = "+15550001111";
  const SENTINEL_EMAIL = "private@example.test";
  const SENTINEL_MESSAGE = "SUPER-SECRET-MESSAGE";

  it("a plain object -> only top-level key names and a count, no values", () => {
    const result = conservativeAuditFallback({ phone: SENTINEL_PHONE, email: SENTINEL_EMAIL, note: SENTINEL_MESSAGE });
    expect(result).toEqual({ redacted: true, keys: ["phone", "email", "note"], fieldCount: 3 });
    expect(JSON.stringify(result)).not.toContain(SENTINEL_PHONE);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_EMAIL);
    expect(JSON.stringify(result)).not.toContain(SENTINEL_MESSAGE);
  });

  it("non-object input (string, number, array, null, undefined) -> empty, still safe", () => {
    expect(conservativeAuditFallback(SENTINEL_MESSAGE)).toEqual({ redacted: true, keys: [], fieldCount: 0 });
    expect(conservativeAuditFallback(42)).toEqual({ redacted: true, keys: [], fieldCount: 0 });
    expect(conservativeAuditFallback([SENTINEL_PHONE, SENTINEL_EMAIL])).toEqual({ redacted: true, keys: [], fieldCount: 0 });
    expect(conservativeAuditFallback(null)).toEqual({ redacted: true, keys: [], fieldCount: 0 });
    expect(conservativeAuditFallback(undefined)).toEqual({ redacted: true, keys: [], fieldCount: 0 });
  });
});

describe("summarizeForAudit — the ONLY path the runtime uses to compute a persisted audit summary", () => {
  it("no summarizer defined -> falls back to conservativeAuditFallback", () => {
    expect(summarizeForAudit(undefined, { secret: "value" })).toEqual({ redacted: true, keys: ["secret"], fieldCount: 1 });
  });

  it("a summarizer that throws -> falls back to conservativeAuditFallback, never crashes", () => {
    const throwingSummarizer = (): Record<string, unknown> => {
      throw new Error("boom");
    };
    expect(summarizeForAudit(throwingSummarizer, { a: 1, b: 2 })).toEqual({ redacted: true, keys: ["a", "b"], fieldCount: 2 });
  });

  it("a summarizer that returns something malformed (not a plain object) -> falls back", () => {
    const badSummarizer = (): any => "not an object";
    expect(summarizeForAudit(badSummarizer, { x: 1 })).toEqual({ redacted: true, keys: ["x"], fieldCount: 1 });
  });

  it("a well-behaved summarizer's own return value is used as-is", () => {
    const goodSummarizer = (value: unknown) => ({ length: typeof value === "string" ? value.length : -1 });
    expect(summarizeForAudit(goodSummarizer, "hello")).toEqual({ length: 5 });
  });
});

describe("per-tool audit summarizers (P0.9 Slice C correction 2) — sentinel values never appear", () => {
  const SENTINEL_MESSAGE = "SUPER-SECRET-MESSAGE";

  it("create_internal_note: summarizes to a length only, never the note text", () => {
    const summary = createInternalNoteTool.summarizeInputForAudit!({ note: SENTINEL_MESSAGE });
    expect(summary).toEqual({ noteLength: SENTINEL_MESSAGE.length });
    expect(JSON.stringify(summary)).not.toContain(SENTINEL_MESSAGE);
  });

  it("create_internal_note summarizers are total against malformed/unknown input (correction 2B)", () => {
    expect(createInternalNoteTool.summarizeInputForAudit!(null)).toEqual({ redacted: true, keys: [], fieldCount: 0 });
    expect(createInternalNoteTool.summarizeInputForAudit!({ note: 12345 })).toEqual({ redacted: true, keys: ["note"], fieldCount: 1 });
    expect(createInternalNoteTool.summarizeOutputForAudit!("not an object" as unknown)).toEqual({ redacted: true, keys: [], fieldCount: 0 });
  });

  it("draft_customer_message: summarizes to hasDraft/draftLength only, never the draft text", () => {
    const summary = draftCustomerMessageTool.summarizeInputForAudit!({ draft: SENTINEL_MESSAGE });
    expect(summary).toEqual({ hasDraft: true, draftLength: SENTINEL_MESSAGE.length });
    expect(JSON.stringify(summary)).not.toContain(SENTINEL_MESSAGE);

    const outputSummary = draftCustomerMessageTool.summarizeOutputForAudit!({ draft: SENTINEL_MESSAGE });
    expect(outputSummary).toEqual({ hasDraft: true, draftLength: SENTINEL_MESSAGE.length });
    expect(JSON.stringify(outputSummary)).not.toContain(SENTINEL_MESSAGE);
  });

  it("draft_customer_message summarizers are total against malformed/unknown input", () => {
    expect(draftCustomerMessageTool.summarizeInputForAudit!(null)).toEqual({ redacted: true, keys: [], fieldCount: 0 });
    expect(draftCustomerMessageTool.summarizeInputForAudit!({ draft: 42 })).toEqual({ redacted: true, keys: ["draft"], fieldCount: 1 });
  });

  it("ping defines no explicit summarizer by design — proves the runtime fallback covers a tool author who forgot", () => {
    expect(pingTool.summarizeInputForAudit).toBeUndefined();
    expect(pingTool.summarizeOutputForAudit).toBeUndefined();
  });
});
