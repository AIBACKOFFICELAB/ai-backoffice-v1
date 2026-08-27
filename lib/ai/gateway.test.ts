import { describe, it, expect } from "vitest";
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

  it("records a failed invocation and rethrows when the provider throws", async () => {
    const provider = new FakeChatProvider(undefined, true);
    const invocationStore = new InMemoryModelInvocationStore();
    const gateway = new AiGateway({ chatProviders: { fake: provider }, invocationStore });

    await expect(gateway.reason({ tenantId: "t1", prompt: "why?" })).rejects.toThrow("provider exploded");
    const recorded = invocationStore.all();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].status).toBe("failed");
    expect(recorded[0].error).toContain("provider exploded");
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
});
