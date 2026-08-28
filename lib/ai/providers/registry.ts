import { ChatProvider, EmbeddingProvider } from "./types";
import { AnthropicChatProvider } from "./anthropic";
import { MockChatProvider, MockEmbeddingProvider } from "./mock";
import { isMockProviderAllowed } from "../environment";

/**
 * P0.9 Slice C, finding M-01: the 'mock' provider is registered only in
 * dev/test (or under an explicit AI_GATEWAY_ALLOW_MOCK=true override) — see
 * lib/ai/environment.ts. In production with no real provider configured,
 * this now returns a registry with NO usable chat provider at all; the
 * gateway's own existing "no provider configured for '<x>'" check
 * (lib/ai/gateway.ts::invokeText/embed, already present since P0.2) then
 * fires as a loud, audited AiGatewayError at first actual USE — not at
 * import/construction time, which would otherwise risk crashing unrelated
 * routes that merely import this module transitively. A real provider is
 * still added whenever it's actually configured, in every environment. See
 * docs/MODEL_GATEWAY.md "Provider independence."
 */
export function getDefaultChatProviders(): Record<string, ChatProvider> {
  const providers: Record<string, ChatProvider> = {};
  if (isMockProviderAllowed()) providers.mock = new MockChatProvider();
  const anthropic = new AnthropicChatProvider();
  if (anthropic.configured) providers.anthropic = anthropic;
  return providers;
}

export function getDefaultEmbeddingProviders(): Record<string, EmbeddingProvider> {
  // No embeddings provider is wired up yet (Anthropic does not offer one).
  // Same production fail-closed policy as chat providers above — see
  // docs/MODEL_GATEWAY.md "Known gaps."
  const providers: Record<string, EmbeddingProvider> = {};
  if (isMockProviderAllowed()) providers.mock = new MockEmbeddingProvider();
  return providers;
}
