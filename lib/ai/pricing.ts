/**
 * Best-effort cost estimation for model_invocations.estimated_cost_usd.
 *
 * Deliberately returns null for any provider/model without a confirmed
 * price in this table rather than fabricating a number — P0.8's outcome
 * layer explicitly forbids inventing ROI, and a made-up cost is the same
 * failure mode. Populate PRICING_TABLE with confirmed $/million-token rates
 * before relying on this for financial reporting.
 */
const PRICING_TABLE: Record<string, { inputPerMillion: number; outputPerMillion: number } | undefined> = {};

export function estimateCostUsd(
  provider: string,
  model: string,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined
): number | null {
  const price = PRICING_TABLE[`${provider}:${model}`];
  if (!price || inputTokens == null || outputTokens == null) return null;
  return (inputTokens / 1_000_000) * price.inputPerMillion + (outputTokens / 1_000_000) * price.outputPerMillion;
}
