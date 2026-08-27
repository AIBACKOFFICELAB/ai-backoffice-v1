import { AiRoutingMetadata, AiTaskType } from "./types";

export type RouteDecision = { provider: string; model: string };

const PREFERRED_PROVIDER = "anthropic";

/**
 * Anthropic model selection. Uses the current model family — swap this
 * table, not call sites, when models change. See docs/MODEL_GATEWAY.md.
 */
function selectAnthropicModel(meta: AiRoutingMetadata, taskType: AiTaskType): string {
  if (taskType === "classify" && !meta.complexity) return "claude-haiku-4-5-20251001";
  if (meta.costPreference === "low" || meta.latencyPreference === "fast") return "claude-haiku-4-5-20251001";
  if (meta.complexity === "high" || meta.latencyPreference === "quality") return "claude-opus-5";
  return "claude-sonnet-5";
}

/**
 * Deterministic routing policy: given what a caller says it needs and which
 * providers are actually configured/available, decide provider + model.
 * This is intentionally simple (a lookup table, not a model choosing a
 * model) so it's auditable and cheap — see model_policy on the agents table
 * for how an individual agent can bias this later without a gateway change.
 *
 * Falls back to 'mock' when the preferred provider isn't configured (e.g.
 * no ANTHROPIC_API_KEY set) so the rest of the agent runtime stays
 * operable in dev/CI — matches the "deterministic fallback" principle in
 * docs/constitution/01_PRODUCT_VISION.md.
 */
export function resolveRoute(meta: AiRoutingMetadata, taskType: AiTaskType, availableProviders: string[]): RouteDecision {
  const provider = availableProviders.includes(PREFERRED_PROVIDER) ? PREFERRED_PROVIDER : availableProviders[0] ?? PREFERRED_PROVIDER;

  if (provider === "anthropic") {
    return { provider, model: selectAnthropicModel(meta, taskType) };
  }

  return { provider, model: `${provider}-standard` };
}
