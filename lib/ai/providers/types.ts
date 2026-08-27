export type ChatCompleteParams = {
  prompt: string;
  system?: string;
  model: string;
  maxOutputTokens?: number;
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
};

export type EmbedResult = {
  vectors: number[][];
  inputTokens?: number;
};

export interface EmbeddingProvider {
  id: string;
  embed(params: EmbedParams): Promise<EmbedResult>;
}
