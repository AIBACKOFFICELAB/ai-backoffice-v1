import Anthropic from "@anthropic-ai/sdk";
import { ChatProvider, ChatCompleteParams, ChatCompleteResult } from "./types";

/**
 * The only file in this codebase allowed to import @anthropic-ai/sdk.
 * Everything upstream of the gateway talks in provider-neutral terms — see
 * docs/MODEL_GATEWAY.md "Provider independence."
 */
export class AnthropicChatProvider implements ChatProvider {
  id = "anthropic";
  private client: Anthropic | null;

  constructor(apiKey: string | undefined = process.env.ANTHROPIC_API_KEY) {
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
  }

  /** Fail-closed, matching the existing lib/sms/twilio.ts pattern: the
   * registry only offers this provider when it's actually configured. */
  get configured(): boolean {
    return this.client !== null;
  }

  async complete(params: ChatCompleteParams): Promise<ChatCompleteResult> {
    if (!this.client) {
      throw new Error("Anthropic provider not configured: ANTHROPIC_API_KEY is not set");
    }

    const response = await this.client.messages.create(
      {
        model: params.model,
        max_tokens: params.maxOutputTokens ?? 1024,
        ...(params.system ? { system: params.system } : {}),
        messages: [{ role: "user", content: params.prompt }],
      },
      params.signal ? { signal: params.signal } : undefined
    );

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return {
      text,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    };
  }
}
