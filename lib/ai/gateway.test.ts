import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AiGateway } from "./gateway";
import { AiGatewayError } from "./types";
import { InMemoryModelInvocationStore } from "./store";
import { ChatProvider, ChatCompleteParams, ChatCompleteResult } from "./providers/types";

class FakeChatProvider implements ChatProvider {
  id = "fake";
  calls: ChatCompleteParams[] = [];
  constructor(private response: ChatCompleteResult = { text: "ok", inputTokens: 10, outputTokens: 5 }, private shouldThrow = false) {}
  async complete(params: ChatCompleteParams): Promise<ChatCompleteResult> {
    this.calls.push(params);
    if (this.shouldThrow) throw new Error("provider exploded");
    return this.response;
  }
}

describe("AiGateway — provider-neutral abstraction (P0.2)", () => {
  it("routes generate() through the configured provider and records a model_invocation", async () => {
    const provider = new FakeChatProvider();
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: { fake: provider }, invocationStore });

    const result = await gateway.generate({ tenantId: "t1", prompt: "hello" });

    expect(result.text).toBe("ok");
    expect(provider.calls).toHaveLength(1);
    const recorded = invocationStore.all();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ tenantId: "t1", taskType: "generate", provider: "fake", status: "succeeded" });
  });

  it("business logic never sees a provider-specific name in the response beyond the routed provider id", async () => {
    const provider = new FakeChatProvider();
    const gateway = new AiGateway({ chatProviders: { fake: provider }, invocationStore: new InMemoryModelInvocationStore() });
    const result = await gateway.classify({ tenantId: "t1", prompt: "is this urgent?" });
    expect(result.provider).toBe("fake");
  });

  it("records a failed invocation, normalizes the error, and never leaks the raw provider message (P0.9 Slice C, finding C.6)", async () => {
    // Before Slice C this asserted the raw "provider exploded" text
    // propagated through untouched — that was itself the leak finding C.6
    // remediates: a provider error can echo back request content (prompt
    // text, which may carry customer PII), so the gateway now normalizes
    // every provider failure to a fixed, category-specific message and
    // never surfaces the original text in the thrown error or the
    // persisted model_invocations audit row. See
    // lib/ai/gateway.ts::normalizeProviderError.
    const provider = new FakeChatProvider(undefined, true);
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: { fake: provider }, invocationStore });

    await expect(gateway.reason({ tenantId: "t1", prompt: "why?" })).rejects.toMatchObject({ name: "AiGatewayError", category: "unknown" });
    const recorded = invocationStore.all();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].status).toBe("failed");
    expect(recorded[0].error).not.toContain("provider exploded");
    expect(recorded[0].errorCategory).toBe("unknown");
  });

  it("throws AiGatewayError and still records the attempt when no provider is configured at all", async () => {
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: {}, invocationStore });
    await expect(gateway.summarize({ tenantId: "t1", prompt: "text" })).rejects.toBeInstanceOf(AiGatewayError);
    expect(invocationStore.all()).toHaveLength(1);
    expect(invocationStore.all()[0].status).toBe("failed");
  });

  it("swapping providers requires no change to call sites — same request shape, different registered provider", async () => {
    const providerA = new FakeChatProvider({ text: "from A" });
    const providerB = new FakeChatProvider({ text: "from B" });

    const gatewayA = new AiGateway({ chatProviders: { fake: providerA }, invocationStore: new InMemoryModelInvocationStore() });
    const gatewayB = new AiGateway({ chatProviders: { fake: providerB }, invocationStore: new InMemoryModelInvocationStore() });

    const request = { tenantId: "t1", prompt: "same request" };
    expect((await gatewayA.generate(request)).text).toBe("from A");
    expect((await gatewayB.generate(request)).text).toBe("from B");
  });

  it("embed() routes through an embedding provider and records usage", async () => {
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({
      chatProviders: {},
      embeddingProviders: { fake: { id: "fake", embed: async (p) => ({ vectors: p.input.map(() => [1, 2, 3]), inputTokens: 4 }) } },
      invocationStore,
    });
    const result = await gateway.embed({ tenantId: "t1", input: ["a", "b"] });
    expect(result.vectors).toHaveLength(2);
    expect(invocationStore.all()[0]).toMatchObject({ taskType: "embed", status: "succeeded" });
  });

  it("successful request records provider/model/tokens/latency/cost", async () => {
    const provider = new FakeChatProvider({ text: "ok", inputTokens: 42, outputTokens: 17 });
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: { fake: provider }, invocationStore });

    await gateway.generate({ tenantId: "t1", prompt: "hello" });
    const recorded = invocationStore.all()[0];
    expect(recorded.provider).toBe("fake");
    expect(recorded.inputTokens).toBe(42);
    expect(recorded.outputTokens).toBe(17);
    expect(recorded.latencyMs).toBeGreaterThanOrEqual(0);
    // estimateCostUsd (lib/ai/pricing.ts) deliberately returns null for any
    // provider/model without a confirmed price — PRICING_TABLE is
    // currently empty, so null here is correct, not a gap this test found.
    expect(recorded.estimatedCostUsd).toBeNull();
    expect(recorded.errorCategory).toBeNull();
  });
});

/** A ChatProvider whose complete() never resolves — proves the gateway's
 * own deadline, not provider cooperation, is what returns control to the
 * caller (P0.9 Slice C, finding M-05). */
class HangingChatProvider implements ChatProvider {
  id = "hanging";
  async complete(): Promise<ChatCompleteResult> {
    return new Promise(() => {});
  }
}

class StatusErrorChatProvider implements ChatProvider {
  id = "status-error";
  constructor(private status: number) {}
  async complete(): Promise<ChatCompleteResult> {
    const error = new Error("raw provider body: sk-secret-test-key-should-never-leak") as Error & { status: number };
    error.status = this.status;
    throw error;
  }
}

describe("AiGateway — deadlines and normalized error taxonomy (P0.9 Slice C, finding M-05)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scenario: provider never resolves -> gateway times out rather than hanging forever", async () => {
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: { hanging: new HangingChatProvider() }, invocationStore });

    const resultPromise = gateway.generate({ tenantId: "t1", prompt: "hello", timeoutMs: 5000 });
    // Prevent an unhandled rejection warning while we drive fake timers —
    // we assert on the same promise below via expect().rejects.
    resultPromise.catch(() => {});

    await vi.advanceTimersByTimeAsync(5001);
    await expect(resultPromise).rejects.toMatchObject({ category: "timeout" });
  });

  it("scenario: provider timeout is recorded as a failed invocation with category 'timeout'", async () => {
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: { hanging: new HangingChatProvider() }, invocationStore });

    const resultPromise = gateway.reason({ tenantId: "t1", prompt: "hello", timeoutMs: 1000 });
    resultPromise.catch(() => {});
    await vi.advanceTimersByTimeAsync(1001);
    await expect(resultPromise).rejects.toBeInstanceOf(AiGatewayError);

    const recorded = invocationStore.all();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].status).toBe("failed");
    expect(recorded[0].errorCategory).toBe("timeout");
  });

  it("scenario: a provider auth failure (401/403) is normalized to category 'authentication'", async () => {
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: { "status-error": new StatusErrorChatProvider(401) }, invocationStore });

    const resultPromise = gateway.generate({ tenantId: "t1", prompt: "hello" });
    await expect(resultPromise).rejects.toMatchObject({ category: "authentication" });
    expect(invocationStore.all()[0].errorCategory).toBe("authentication");
  });

  it("scenario: a provider rate-limit failure (429) is normalized to category 'rate_limited'", async () => {
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: { "status-error": new StatusErrorChatProvider(429) }, invocationStore });

    const resultPromise = gateway.generate({ tenantId: "t1", prompt: "hello" });
    await expect(resultPromise).rejects.toMatchObject({ category: "rate_limited" });
    expect(invocationStore.all()[0].errorCategory).toBe("rate_limited");
  });

  it("scenario: a provider-specific raw error message never leaks (no secret/test PII in the thrown error or the audit row)", async () => {
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: { "status-error": new StatusErrorChatProvider(500) }, invocationStore });

    let thrown: unknown;
    try {
      await gateway.generate({ tenantId: "t1", prompt: "hello" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AiGatewayError);
    expect((thrown as AiGatewayError).message).not.toContain("sk-secret-test-key-should-never-leak");
    expect((thrown as AiGatewayError).category).toBe("provider_unavailable");

    const recorded = invocationStore.all()[0];
    expect(recorded.error).not.toContain("sk-secret-test-key-should-never-leak");
  });

  it("configuration errors (no provider registered) never contain a secret value", async () => {
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: {}, invocationStore });
    let thrown: unknown;
    try {
      await gateway.generate({ tenantId: "t1", prompt: "hello" });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as AiGatewayError).category).toBe("configuration");
    expect((thrown as AiGatewayError).message).not.toMatch(/sk-|api[_-]?key/i);
  });
});

/**
 * Minimal structured-output validation primitive (P0.9 Slice C, finding
 * M-05/C.9). NOT a P1 autonomous tool-selection loop — a caller supplies
 * its own validator.
 */
describe("AiGateway.generateStructured — minimal structured output validation (C.9)", () => {
  it("returns the validated value when the model's raw text parses correctly", async () => {
    const provider = new FakeChatProvider({ text: '{"ok":true,"n":42}' });
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: { fake: provider }, invocationStore });

    const result = await gateway.generateStructured<{ ok: boolean; n: number }>({
      tenantId: "t1",
      prompt: "return json",
      validate: (raw) => {
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed.ok !== "boolean" || typeof parsed.n !== "number") return { ok: false, errors: ["missing fields"] };
          return { ok: true, value: parsed };
        } catch {
          return { ok: false, errors: ["not valid JSON"] };
        }
      },
    });

    expect(result.value).toEqual({ ok: true, n: 42 });
    expect(invocationStore.all()).toHaveLength(1);
    expect(invocationStore.all()[0].status).toBe("succeeded");
  });

  it("scenario: malformed structure -> normalized 'invalid_response' failure, never silently trusted as structured data", async () => {
    const provider = new FakeChatProvider({ text: "not json at all" });
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: { fake: provider }, invocationStore });

    await expect(
      gateway.generateStructured({
        tenantId: "t1",
        prompt: "return json",
        validate: (raw) => {
          try {
            return { ok: true, value: JSON.parse(raw) };
          } catch {
            return { ok: false, errors: ["not valid JSON"] };
          }
        },
      })
    ).rejects.toMatchObject({ category: "invalid_response" });

    // Two invocation records: the raw completion (succeeded — the provider
    // DID respond) and the structured-contract failure (failed) — the
    // successful raw completion is never retroactively rewritten.
    const recorded = invocationStore.all();
    expect(recorded).toHaveLength(2);
    expect(recorded.filter((r) => r.status === "succeeded")).toHaveLength(1);
    expect(recorded.filter((r) => r.status === "failed" && r.errorCategory === "invalid_response")).toHaveLength(1);
  });
});
