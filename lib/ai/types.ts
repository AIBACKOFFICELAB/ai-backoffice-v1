/**
 * Model Gateway types (P0.2). See docs/MODEL_GATEWAY.md.
 *
 * Application/business logic must never import a provider SDK directly or
 * reference a provider by name outside this directory — everything routes
 * through AiGateway (gateway.ts), which is the only place that knows which
 * provider/model actually serves a request.
 */

export type AiTaskType = "generate" | "reason" | "classify" | "extract" | "summarize" | "embed";

export type AiComplexity = "low" | "medium" | "high";
export type LatencyPreference = "fast" | "balanced" | "quality";
export type CostPreference = "low" | "balanced" | "premium";
export type PrivacyClass = "public" | "internal" | "customer_pii" | "financial";

export type AiRoutingMetadata = {
  complexity?: AiComplexity;
  latencyPreference?: LatencyPreference;
  costPreference?: CostPreference;
  requiredCapabilities?: string[];
  privacyClass?: PrivacyClass;
  tenantId: string;
  workflowId?: string;
  /** Set when called from inside the agent runtime — ties the model
   * invocation back to its run for the P0.7 observability chain. */
  agentRunId?: string | null;
};

export type AiTextRequestInput = AiRoutingMetadata & {
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
};

export type AiTextRequest = AiTextRequestInput & { taskType: AiTaskType };

export type AiTextResponse = {
  text: string;
  provider: string;
  model: string;
  usage: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
  invocationId: string;
};

export type AiEmbedRequestInput = AiRoutingMetadata & {
  input: string[];
};

export type AiEmbedRequest = AiEmbedRequestInput & { taskType: "embed" };

export type AiEmbedResponse = {
  vectors: number[][];
  provider: string;
  model: string;
  usage: { inputTokens?: number };
  latencyMs: number;
  invocationId: string;
};

export class AiGatewayError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "AiGatewayError";
  }
}
