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
   * C, finding M-05/C.9; hardened by Slice C correction 4). NOT an
   * autonomous tool-selection loop — the caller supplies its own
   * `validate`. Uses callChatProvider (see below) directly, NOT
   * invokeText, specifically so this method controls recording itself:
   * exactly ONE model_invocations row is ever written for the one
   * physical provider call this method makes, whichever way it resolves.
   * A malformed response is recorded as that single row with
   * status='failed', errorCategory='invalid_response', and a FIXED,
   * sanitized message — the caller-supplied validator's own `errors`
   * strings are deliberately NEVER interpolated into the persisted or
   * thrown message, since a validator can echo back text from the model's
   * response (and therefore customer PII) in its own error output. The
   * row still preserves the real provider/model/token/latency metadata
   * from that one physical call.
   */
  async generateStructured<T>(request: AiStructuredRequestInput<T>): Promise<AiStructuredResponse<T>> {
    const { validate, ...textRequest } = request;
    const { route, invocationId, outcome } = await this.callChatProvider({ ...textRequest, taskType: "generate" });

    if (!outcome.ok) {
      await this.recordFailure(invocationId, request, "generate", route, outcome.error, outcome.latencyMs);
      throw outcome.error;
    }

    const validation = validate(outcome.text);

    if (!validation.ok) {
      const validationError = new AiGatewayError("structured output failed validation", "invalid_response");
      // The provider DID respond (outcome.ok === true) — preserve its real
      // token counts on this single failed row rather than losing them.
      await this.recordFailure(invocationId, request, "generate", route, validationError, outcome.latencyMs, {
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
      });
      throw validationError;
    }

    await this.recordSuccess(invocationId, request, "generate", route, outcome);

    return {
      value: validation.value,
      provider: route.provider,
      model: route.model,
      usage: { inputTokens: outcome.inputTokens ?? undefined, outputTokens: outcome.outputTokens ?? undefined },
      latencyMs: outcome.latencyMs,
      invocationId,
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
    const { route, invocationId, outcome } = await this.callChatProvider(request);

    if (!outcome.ok) {
      await this.recordFailure(invocationId, request, request.taskType, route, outcome.error, outcome.latencyMs);
      throw outcome.error;
    }

    await this.recordSuccess(invocationId, request, request.taskType, route, outcome);
    return {
      text: outcome.text,
      provider: route.provider,
      model: route.model,
      usage: { inputTokens: outcome.inputTokens ?? undefined, outputTokens: outcome.outputTokens ?? undefined },
      latencyMs: outcome.latencyMs,
      invocationId,
    };
  }

  /**
   * Non-recording chat-provider call primitive (P0.9 Slice C correction 4)
   * factored out of invokeText so generateStructured can also use it: both
   * need to resolve a route, actually call the provider under the
   * deadline, and get back either a successful result or a normalized
   * error — WITHOUT anything being written to model_invocations yet. Each
   * caller decides for itself exactly what single row to record for the
   * one physical call this makes (invokeText always records the outcome
   * as-is; generateStructured additionally may turn an ok=true outcome
   * into a 'failed'/invalid_response row if the caller's own `validate`
   * rejects the text). This function itself never records anything, so it
   * cannot be the source of a double-counted invocation.
   */
  private async callChatProvider(request: AiTextRequestInput & { taskType: AiTaskType }): Promise<{
    route: { provider: string; model: string };
    invocationId: string;
    outcome:
      | { ok: true; text: string; inputTokens: number | null; outputTokens: number | null; latencyMs: number }
      | { ok: false; error: AiGatewayError; latencyMs: number | null };
  }> {
    const route = resolveRoute(request, request.taskType, Object.keys(this.chatProviders));
    const provider = this.chatProviders[route.provider];
    const invocationId = randomUUID();
    const startedAt = Date.now();

    if (!provider) {
      const configError = noProviderConfiguredError(route.provider, Object.keys(this.chatProviders));
      return { route, invocationId, outcome: { ok: false, error: configError, latencyMs: null } };
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
      return {
        route,
        invocationId,
        outcome: { ok: true, text: result.text, inputTokens: result.inputTokens ?? null, outputTokens: result.outputTokens ?? null, latencyMs },
      };
    } catch (error) {
      const normalized = normalizeProviderError(error);
      return { route, invocationId, outcome: { ok: false, error: normalized, latencyMs: Date.now() - startedAt } };
    }
  }

  private async recordSuccess(
    invocationId: string,
    request: { tenantId: string; agentRunId?: string | null; complexity?: string; latencyPreference?: string; costPreference?: string },
    taskType: AiTaskType,
    route: { provider: string; model: string },
    outcome: { inputTokens: number | null; outputTokens: number | null; latencyMs: number }
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
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      latencyMs: outcome.latencyMs,
      estimatedCostUsd: estimateCostUsd(route.provider, route.model, outcome.inputTokens, outcome.outputTokens),
      status: "succeeded",
      error: null,
      errorCategory: null,
    });
  }

  private async recordFailure(
    invocationId: string,
    request: { tenantId: string; agentRunId?: string | null; complexity?: string; latencyPreference?: string; costPreference?: string },
    taskType: AiTaskType,
    route: { provider: string; model: string },
    error: AiGatewayError,
    latencyMs: number | null = null,
    // P0.9 Slice C correction 4: generateStructured's invalid_response case
    // is a failure where the provider DID respond — real token counts are
    // known and must be preserved on the single failed row, unlike an
    // ordinary provider failure (timeout, auth, etc.), where nothing was
    // ever returned and these stay null (the default every other caller of
    // recordFailure relies on).
    tokens: { inputTokens: number | null; outputTokens: number | null } = { inputTokens: null, outputTokens: null }
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
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      latencyMs,
      // P0.9 Slice D, D.12: a real provider response can precede this
      // failure (generateStructured's invalid_response case) — the
      // provider call itself still consumed real tokens/cost regardless of
      // what the caller's own validator decided afterward, so this must
      // not be hardcoded null. estimateCostUsd is already null-safe for
      // every OTHER recordFailure caller (timeout/auth/rate-limit/
      // no-provider-configured), where tokens is always the {null, null}
      // default — same call, same correct null result, no special-casing
      // needed. estimateCostUsd itself still returns null whenever
      // PRICING_TABLE has no confirmed price for a given provider/model
      // (see lib/ai/pricing.ts) — a pre-existing, documented, honest gap
      // this call does not change.
      estimatedCostUsd: estimateCostUsd(route.provider, route.model, tokens.inputTokens, tokens.outputTokens),
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
