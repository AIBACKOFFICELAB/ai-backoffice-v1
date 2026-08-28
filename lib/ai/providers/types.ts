export type ChatCompleteParams = {
  prompt: string;
  system?: string;
  model: string;
  maxOutputTokens?: number;
  /** P0.9 Slice C, finding M-05: best-effort cancellation signal for the
   * gateway's own deadline (lib/ai/gateway.ts). A provider that doesn't
   * support cancellation may ignore this — the gateway's own Promise.race
   * against its deadline still returns to the caller on time regardless;
   * the signal is purely so a cooperating provider SDK can also stop doing
   * work/consuming quota in the background. */
  signal?: AbortSignal;
};

export type ChatCompleteResult = {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
};

export interface ChatProvider {
  id: string;
  complete(params: ChatCompleteParams): Promise<ChatCompleteResult>;
}

export type EmbedParams = {
  input: string[];
  model: string;
  /** See ChatCompleteParams.signal above. */
  signal?: AbortSignal;
};

export type EmbedResult = {
  vectors: number[][];
  inputTokens?: number;
};

export interface EmbeddingProvider {
  id: string;
  embed(params: EmbedParams): Promise<EmbedResult>;
}
