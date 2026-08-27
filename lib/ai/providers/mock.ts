import { ChatProvider, ChatCompleteParams, ChatCompleteResult, EmbeddingProvider, EmbedParams, EmbedResult } from "./types";

/**
 * Deterministic provider used for tests and for running the P0 agent
 * runtime end-to-end without a live API key or network access. The router
 * (lib/ai/router.ts) only selects 'mock' when no configured real provider
 * is available — production traffic with ANTHROPIC_API_KEY set never
 * touches this.
 */
export class MockChatProvider implements ChatProvider {
  id = "mock";

  async complete(params: ChatCompleteParams): Promise<ChatCompleteResult> {
    const text = `[mock:${params.model}] ${params.prompt.slice(0, 200)}`;
    return {
      text,
      inputTokens: Math.ceil(params.prompt.length / 4),
      outputTokens: Math.ceil(text.length / 4),
    };
  }
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  id = "mock";

  async embed(params: EmbedParams): Promise<EmbedResult> {
    const vectors = params.input.map((text) => {
      // Deterministic, cheap pseudo-embedding — not semantically meaningful,
      // only useful for exercising the gateway's plumbing without a real
      // embeddings provider configured (see docs/MODEL_GATEWAY.md).
      const seed = Array.from(text).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
      return Array.from({ length: 8 }, (_, i) => Math.sin(seed + i));
    });
    return {
      vectors,
      inputTokens: params.input.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
    };
  }
}
