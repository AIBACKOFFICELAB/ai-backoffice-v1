import { randomUUID } from "crypto";
import {
  AiGatewayError,
  AiTaskType,
  AiTextRequestInput,
  AiTextResponse,
  AiEmbedRequestInput,
  AiEmbedResponse,
  AiStructuredRequestInput,
  AiStructuredResponse,
} from "./types";
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

/** Finite deadlines (P0.9 Slice C, finding M-05) — every provider
 * invocation has SOME bound. Generous enough for a real LLM completion,
 * bounded well under typical serverless function limits. Override per call
 * via `timeoutMs` on the request. */
const DEFAULT_TEXT_TIMEOUT_MS = 30_000;
const DEFAULT_EMBED_TIMEOUT_MS = 15_000;

/**
 * Provider-neutral AI abstraction (P0.2, hardened P0.9 Slice C — findings
 * M-01, M-05). Business logic calls `ai.generate()` / `ai.reason()` /
 * `ai.classify()` / `ai.extract()` / `ai.summarize()` / `ai.embed()` /
 * `ai.generateStructured()` — never a provider SDK directly. See
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

  /**
   * Minimal, provider-independent structured-output primitive (P0.9 Slice
   * C, finding M-05/C.9). NOT an autonomous tool-selection loop — the
   * caller supplies its own `validate`. A malformed response is a
   * normalized `invalid_response` AiGatewayError, recorded as a failed
   * invocation, never silently trusted as parsed data.
   */
  async generateStructured<T>(request: AiStructuredRequestInput<T>): Promise<AiStructuredResponse<T>> {
    const { validate, ...textRequest } = request;
    const response = await this.invokeText({ ...textRequest, taskType: "generate" });
    const validation = validate(response.text);

    if (!validation.ok) {
      // The raw completion itself was already recorded as a succeeded
      // invocation by invokeText above — that's still true (the provider
      // did respond). This is a SEPARATE, additional failed-invocation
      // record reflecting the true caller-facing outcome: the structured
      // contract was violated. Never rewritten retroactively.
      await this.invocationStore.record({
        id: randomUUID(),
        tenantId: request.tenantId,
        agentRunId: request.agentRunId ?? null,
        taskType: "generate",
        provider: response.provider,
        model: response.model,
        complexity: request.complexity ?? null,
        latencyPreference: request.latencyPreference ?? null,
        costPreference: request.costPreference ?? null,
        inputTokens: response.usage.inputTokens ?? null,
        outputTokens: response.usage.outputTokens ?? null,
        latencyMs: response.latencyMs,
        estimatedCostUsd: null,
        status: "failed",
        error: "structured output validation failed",
        errorCategory: "invalid_response",
      });
      throw new AiGatewayError(`structured output validation failed: ${validation.errors.join("; ")}`, "invalid_response");
    }

    return {
      value: validation.value,
      provider: response.provider,
      model: response.model,
      usage: response.usage,
      latencyMs: response.latencyMs,
      invocationId: response.invocationId,
    };
  }

  async embed(request: AiEmbedRequestInput): Promise<AiEmbedResponse> {
    const taskType: AiTaskType = "embed";
    const route = resolveRoute(request, taskType, Object.keys(this.embeddingProviders));
    const provider = this.embeddingProviders[route.provider];
    const invocationId = randomUUID();
    const startedAt = Date.now();

    if (!provider) {
      const configError = noProviderConfiguredError(route.provider, Object.keys(this.embeddingProviders));
      await this.recordFailure(invocationId, request, taskType, route, configError);
      throw configError;
    }

    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;

    try {
      const result = await withDeadline(provider.embed({ input: request.input, model: route.model, signal: controller.signal }), timeoutMs, controller);
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
        errorCategory: null,
      });
      return { vectors: result.vectors, provider: route.provider, model: route.model, usage: { inputTokens: result.inputTokens }, latencyMs, invocationId };
    } catch (error) {
      const normalized = normalizeProviderError(error);
      await this.recordFailure(invocationId, request, taskType, route, normalized, Date.now() - startedAt);
      throw normalized;
    }
  }

  private async invokeText(request: AiTextRequestInput & { taskType: AiTaskType }): Promise<AiTextResponse> {
    const route = resolveRoute(request, request.taskType, Object.keys(this.chatProviders));
    const provider = this.chatProviders[route.provider];
    const invocationId = randomUUID();
    const startedAt = Date.now();

    if (!provider) {
      const configError = noProviderConfiguredError(route.provider, Object.keys(this.chatProviders));
      await this.recordFailure(invocationId, request, request.taskType, route, configError);
      throw configError;
    }

    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? DEFAULT_TEXT_TIMEOUT_MS;

    try {
      const result = await withDeadline(
        provider.complete({ prompt: request.prompt, system: request.system, model: route.model, maxOutputTokens: request.maxOutputTokens, signal: controller.signal }),
        timeoutMs,
        controller
      );
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
        errorCategory: null,
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
      const normalized = normalizeProviderError(error);
      await this.recordFailure(invocationId, request, request.taskType, route, normalized, Date.now() - startedAt);
      throw normalized;
    }
  }

  private async recordFailure(
    invocationId: string,
    request: { tenantId: string; agentRunId?: string | null; complexity?: string; latencyPreference?: string; costPreference?: string },
    taskType: AiTaskType,
    route: { provider: string; model: string },
    error: AiGatewayError,
    latencyMs: number | null = null
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
      latencyMs,
      estimatedCostUsd: null,
      status: "failed",
      // Sanitized, safe message only — see normalizeProviderError; never
      // the raw provider error text (P0.9 Slice C, finding C.6).
      error: error.message,
      errorCategory: error.category,
    });
  }
}

/** Races a provider call against a finite deadline (P0.9 Slice C, finding
 * M-05). On timeout, aborts the controller (best-effort — the provider may
 * or may not actually support cancellation) and rejects with a normalized
 * `timeout` AiGatewayError; the caller never waits past `timeoutMs`
 * regardless of provider cooperation. */
function withDeadline<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new AiGatewayError(`model provider call exceeded its ${timeoutMs}ms deadline`, "timeout"));
    }, timeoutMs);
    if (typeof timer === "object" && "unref" in timer) (timer as { unref(): void }).unref();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function noProviderConfiguredError(provider: string, available: string[]): AiGatewayError {
  return new AiGatewayError(
    `No chat/embedding provider configured for '${provider}' (available: ${available.length > 0 ? available.join(", ") : "none"}). ` +
      "In production this means no real provider is configured — see docs/MODEL_GATEWAY.md and lib/ai/environment.ts.",
    "configuration"
  );
}

/**
 * Normalizes ANY thrown value from a provider call into an AiGatewayError
 * with a safe category and a FIXED, category-specific message (P0.9 Slice
 * C, finding C.6/M-05) — the original error's message/body is deliberately
 * NEVER included, since a provider error can echo back request content
 * (prompt text, which may carry customer PII) or, in principle, secret
 * material. The original error is preserved only as `.cause`, an in-memory
 * property never serialized into logs or the model_invocations audit row.
 */
function normalizeProviderError(error: unknown): AiGatewayError {
  if (error instanceof AiGatewayError) return error;

  const status = (error as { status?: number } | null | undefined)?.status;
  if (status === 401 || status === 403) {
    return new AiGatewayError("model provider rejected the request: authentication failed", "authentication", error);
  }
  if (status === 429) {
    return new AiGatewayError("model provider rate-limited the request", "rate_limited", error);
  }
  if (typeof status === "number" && status >= 500) {
    return new AiGatewayError("model provider is currently unavailable", "provider_unavailable", error);
  }

  const code = (error as { code?: string } | null | undefined)?.code;
  if (code && ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code)) {
    return new AiGatewayError("model provider is currently unavailable", "provider_unavailable", error);
  }

  return new AiGatewayError("model provider call failed", "unknown", error);
}

/** Default gateway instance for application code. Tests construct their own
 * `new AiGateway({ chatProviders: {...}, invocationStore: new InMemoryModelInvocationStore() })`. */
export const ai = new AiGateway();
