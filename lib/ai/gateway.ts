import { randomUUID } from "crypto";
import { AiGatewayError, AiTaskType, AiTextRequestInput, AiTextResponse, AiEmbedRequestInput, AiEmbedResponse } from "./types";
import { resolveRoute } from "./router";
import { ChatProvider, EmbeddingProvider } from "./providers/types";
import { getDefaultChatProviders, getDefaultEmbeddingProviders } from "./providers/registry";
import { ModelInvocationStore, SupabaseModelInvocationStore } from "./store";
import { estimateCostUsd } from "./pricing";

export type AiGatewayDeps = {
  chatProviders?: Record<string, ChatProvider>;
  embeddingProviders?: Record<string, EmbeddingProvider>;
  invocationStore?: ModelInvocationStore;
};

/**
 * Provider-neutral AI abstraction (P0.2). Business logic calls
 * `ai.generate()` / `ai.reason()` / `ai.classify()` / `ai.extract()` /
 * `ai.summarize()` / `ai.embed()` — never a provider SDK directly. See
 * docs/MODEL_GATEWAY.md.
 */
export class AiGateway {
  private chatProviders: Record<string, ChatProvider>;
  private embeddingProviders: Record<string, EmbeddingProvider>;
  private invocationStore: ModelInvocationStore;

  constructor(deps: AiGatewayDeps = {}) {
    this.chatProviders = deps.chatProviders ?? getDefaultChatProviders();
    this.embeddingProviders = deps.embeddingProviders ?? getDefaultEmbeddingProviders();
    this.invocationStore = deps.invocationStore ?? new SupabaseModelInvocationStore();
  }

  async generate(request: AiTextRequestInput): Promise<AiTextResponse> {
    return this.invokeText({ ...request, taskType: "generate" });
  }
  async reason(request: AiTextRequestInput): Promise<AiTextResponse> {
    return this.invokeText({ ...request, taskType: "reason" });
  }
  async classify(request: AiTextRequestInput): Promise<AiTextResponse> {
    return this.invokeText({ ...request, taskType: "classify" });
  }
  async extract(request: AiTextRequestInput): Promise<AiTextResponse> {
    return this.invokeText({ ...request, taskType: "extract" });
  }
  async summarize(request: AiTextRequestInput): Promise<AiTextResponse> {
    return this.invokeText({ ...request, taskType: "summarize" });
  }

  async embed(request: AiEmbedRequestInput): Promise<AiEmbedResponse> {
    const taskType: AiTaskType = "embed";
    const route = resolveRoute(request, taskType, Object.keys(this.embeddingProviders));
    const provider = this.embeddingProviders[route.provider];
    const invocationId = randomUUID();
    const startedAt = Date.now();

    if (!provider) {
      await this.recordFailure(invocationId, request, taskType, route, "provider-not-configured");
      throw new AiGatewayError(`No embedding provider configured for '${route.provider}'`);
    }

    try {
      const result = await provider.embed({ input: request.input, model: route.model });
      const latencyMs = Date.now() - startedAt;
      await this.invocationStore.record({
        id: invocationId,
        tenantId: request.tenantId,
        agentRunId: request.agentRunId ?? null,
        taskType,
        provider: route.provider,
        model: route.model,
        complexity: request.complexity ?? null,
        latencyPreference: request.latencyPreference ?? null,
        costPreference: request.costPreference ?? null,
        inputTokens: result.inputTokens ?? null,
        outputTokens: null,
        latencyMs,
        estimatedCostUsd: estimateCostUsd(route.provider, route.model, result.inputTokens, 0),
        status: "succeeded",
        error: null,
      });
      return { vectors: result.vectors, provider: route.provider, model: route.model, usage: { inputTokens: result.inputTokens }, latencyMs, invocationId };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      await this.invocationStore.record({
        id: invocationId,
        tenantId: request.tenantId,
        agentRunId: request.agentRunId ?? null,
        taskType,
        provider: route.provider,
        model: route.model,
        complexity: request.complexity ?? null,
        latencyPreference: request.latencyPreference ?? null,
        costPreference: request.costPreference ?? null,
        inputTokens: null,
        outputTokens: null,
        latencyMs,
        estimatedCostUsd: null,
        status: "failed",
        error: message,
      });
      throw error;
    }
  }

  private async invokeText(request: AiTextRequestInput & { taskType: AiTaskType }): Promise<AiTextResponse> {
    const route = resolveRoute(request, request.taskType, Object.keys(this.chatProviders));
    const provider = this.chatProviders[route.provider];
    const invocationId = randomUUID();
    const startedAt = Date.now();

    if (!provider) {
      await this.recordFailure(invocationId, request, request.taskType, route, "provider-not-configured");
      throw new AiGatewayError(`No chat provider configured for '${route.provider}'`);
    }

    try {
      const result = await provider.complete({
        prompt: request.prompt,
        system: request.system,
        model: route.model,
        maxOutputTokens: request.maxOutputTokens,
      });
      const latencyMs = Date.now() - startedAt;
      await this.invocationStore.record({
        id: invocationId,
        tenantId: request.tenantId,
        agentRunId: request.agentRunId ?? null,
        taskType: request.taskType,
        provider: route.provider,
        model: route.model,
        complexity: request.complexity ?? null,
        latencyPreference: request.latencyPreference ?? null,
        costPreference: request.costPreference ?? null,
        inputTokens: result.inputTokens ?? null,
        outputTokens: result.outputTokens ?? null,
        latencyMs,
        estimatedCostUsd: estimateCostUsd(route.provider, route.model, result.inputTokens, result.outputTokens),
        status: "succeeded",
        error: null,
      });
      return {
        text: result.text,
        provider: route.provider,
        model: route.model,
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
        latencyMs,
        invocationId,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      await this.invocationStore.record({
        id: invocationId,
        tenantId: request.tenantId,
        agentRunId: request.agentRunId ?? null,
        taskType: request.taskType,
        provider: route.provider,
        model: route.model,
        complexity: request.complexity ?? null,
        latencyPreference: request.latencyPreference ?? null,
        costPreference: request.costPreference ?? null,
        inputTokens: null,
        outputTokens: null,
        latencyMs,
        estimatedCostUsd: null,
        status: "failed",
        error: message,
      });
      throw error;
    }
  }

  private async recordFailure(
    invocationId: string,
    request: { tenantId: string; agentRunId?: string | null; complexity?: string; latencyPreference?: string; costPreference?: string },
    taskType: AiTaskType,
    route: { provider: string; model: string },
    reason: string
  ): Promise<void> {
    await this.invocationStore.record({
      id: invocationId,
      tenantId: request.tenantId,
      agentRunId: request.agentRunId ?? null,
      taskType,
      provider: route.provider,
      model: route.model,
      complexity: request.complexity ?? null,
      latencyPreference: request.latencyPreference ?? null,
      costPreference: request.costPreference ?? null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      estimatedCostUsd: null,
      status: "failed",
      error: reason,
    });
  }
}

/** Default gateway instance for application code. Tests construct their own
 * `new AiGateway({ chatProviders: {...}, invocationStore: new InMemoryModelInvocationStore() })`. */
export const ai = new AiGateway();
