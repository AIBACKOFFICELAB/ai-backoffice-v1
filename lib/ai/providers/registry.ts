import { ChatProvider, EmbeddingProvider } from "./types";
import { AnthropicChatProvider } from "./anthropic";
import { MockChatProvider, MockEmbeddingProvider } from "./mock";

/** The 'mock' provider is always registered so the gateway is always usable
 * (dev, tests, CI without secrets); real providers are added only when
 * actually configured. See docs/MODEL_GATEWAY.md "Provider independence." */
export function getDefaultChatProviders(): Record<string, ChatProvider> {
  const providers: Record<string, ChatProvider> = { mock: new MockChatProvider() };
  const anthropic = new AnthropicChatProvider();
  if (anthropic.configured) providers.anthropic = anthropic;
  return providers;
}

export function getDefaultEmbeddingProviders(): Record<string, EmbeddingProvider> {
  // No embeddings provider is wired up yet (Anthropic does not offer one).
  // 'mock' keeps ai.embed() usable for tests/dev; wire a real provider here
  // when embeddings are actually needed by a workflow — see
  // docs/MODEL_GATEWAY.md "Known gaps."
  return { mock: new MockEmbeddingProvider() };
}
