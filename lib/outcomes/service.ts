import { Outcome, RecordOutcomeInput } from "./types";
import { OutcomeStore, SupabaseOutcomeStore } from "./store";

const defaultStore = new SupabaseOutcomeStore();

/**
 * Record a business outcome. Refuses to record a dollar value without an
 * attribution confidence — P0.8 explicitly forbids inventing ROI, and a
 * currency amount with no stated confidence is exactly that. Non-dollar
 * outcomes (e.g. admin_time_saved measured in minutes via metadata) can
 * still be recorded without outcomeValue.
 */
export async function recordOutcome(input: RecordOutcomeInput, store: OutcomeStore = defaultStore): Promise<Outcome> {
  if (!input.tenantId) throw new Error("recordOutcome requires tenantId");
  if (!input.outcomeType) throw new Error("recordOutcome requires outcomeType");
  if (!input.attributionConfidence) throw new Error("recordOutcome requires attributionConfidence");
  if (input.outcomeValue != null && input.outcomeValue < 0) throw new Error("outcomeValue cannot be negative");
  return store.insert(input);
}

/**
 * Compatibility-adapter helper: record an outcome without ever letting a
 * failure break the calling module's existing behavior. Use this from
 * inside an already-working module, matching emitEventSafely in
 * lib/events/service.ts.
 */
export async function recordOutcomeSafely(input: RecordOutcomeInput, store?: OutcomeStore): Promise<void> {
  try {
    await recordOutcome(input, store);
  } catch (error) {
    console.error(`[outcomes] failed to record ${input.outcomeType} for tenant ${input.tenantId}`, error);
  }
}

export type OutcomeTotals = {
  direct: number;
  assisted: number;
  inferred: number;
  unknown: number;
};

/**
 * Sums outcomeValue by attribution tier. Deliberately keeps the tiers
 * separate rather than returning one blended total — a dashboard showing
 * "$X recovered" should only ever headline `direct` (+ `assisted` if
 * explicitly labeled), never fold `inferred`/`unknown` in silently. See
 * docs/OUTCOME_ATTRIBUTION.md.
 */
export function summarizeOutcomeValue(outcomes: Outcome[]): OutcomeTotals {
  const totals: OutcomeTotals = { direct: 0, assisted: 0, inferred: 0, unknown: 0 };
  for (const outcome of outcomes) {
    if (outcome.outcomeValue == null) continue;
    totals[outcome.attributionConfidence] += outcome.outcomeValue;
  }
  return totals;
}
