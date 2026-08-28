import { Outcome, RecordOutcomeInput } from "./types";
import { OutcomeStore, SupabaseOutcomeStore } from "./store";
import { withTelemetryDeadline, sanitizeTelemetryError, TELEMETRY_DEADLINE_MS } from "@/lib/telemetry/deadline";

const defaultStore = new SupabaseOutcomeStore();

/**
 * Record a business outcome. Refuses to record a dollar value without an
 * attribution confidence — P0.8 explicitly forbids inventing ROI, and a
 * currency amount with no stated confidence is exactly that. Non-dollar
 * outcomes (e.g. admin_time_saved measured in minutes via metadata) can
 * still be recorded without outcomeValue.
 *
 * Idempotent when `input.idempotencyKey` is set (P0.9 Slice C, finding
 * C.3): a repeated call for the same (tenantId, idempotencyKey) returns
 * the ORIGINAL outcome (`deduped: true`), never a duplicate — see
 * lib/outcomes/store.ts.
 */
export async function recordOutcome(input: RecordOutcomeInput, store: OutcomeStore = defaultStore): Promise<{ outcome: Outcome; deduped: boolean }> {
  if (!input.tenantId) throw new Error("recordOutcome requires tenantId");
  if (!input.outcomeType) throw new Error("recordOutcome requires outcomeType");
  if (!input.attributionConfidence) throw new Error("recordOutcome requires attributionConfidence");
  if (input.outcomeValue != null && input.outcomeValue < 0) throw new Error("outcomeValue cannot be negative");
  return store.insert(input);
}

/**
 * Compatibility-adapter helper: record an outcome without ever letting a
 * failure — or a merely-HANGING underlying request — break the calling
 * module's existing behavior (P0.9 Slice C, finding H-01). Bounded by
 * TELEMETRY_DEADLINE_MS, same discipline as emitEventSafely in
 * lib/events/service.ts; see lib/telemetry/deadline.ts for the exact
 * guarantee (never throws, never leaves an unhandled rejection, never
 * pretends a timed-out write actually succeeded). Returns the recorded (or
 * deduped) outcome on success, `null` on any failure or timeout.
 */
export async function recordOutcomeSafely(input: RecordOutcomeInput, store?: OutcomeStore): Promise<Outcome | null> {
  const result = await withTelemetryDeadline(recordOutcome(input, store), {
    onLateSettle: (settled) => {
      if (settled.outcome === "rejected") {
        console.error(
          `[outcomes] record ${input.outcomeType} for tenant ${input.tenantId} failed after its ${TELEMETRY_DEADLINE_MS}ms deadline had already elapsed`,
          sanitizeTelemetryError(settled.error)
        );
      }
    },
  });

  if (result.outcome === "resolved") return result.value.outcome;
  if (result.outcome === "rejected") {
    console.error(`[outcomes] failed to record ${input.outcomeType} for tenant ${input.tenantId}`, sanitizeTelemetryError(result.error));
    return null;
  }
  console.error(`[outcomes] record ${input.outcomeType} for tenant ${input.tenantId} exceeded the ${TELEMETRY_DEADLINE_MS}ms compatibility telemetry deadline — legacy workflow continuing regardless`);
  return null;
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
