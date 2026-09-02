import { BusinessEventStore, SupabaseBusinessEventStore } from "@/lib/events/store";
import { AgentRunStore, SupabaseAgentRunStore } from "../runStore";
import { ModelInvocationStore, SupabaseModelInvocationStore } from "@/lib/ai/store";
import { AgentStore, SupabaseAgentStore } from "../agentStore";
import { getEstimateClosingEvaluation } from "./evaluationReadModel";
import { resolveEstimateClosingAgentStatus, EstimateClosingAgentStatus } from "./status";
import { isEstimateClosingShadowEnabled } from "./featureFlag";
import { ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID } from "./mode";
import { parsePersistedScanCompletedPayload, parsePersistedScanFailedPayload, ScanCompletedPayload } from "./scanTelemetry";
import { getEstimateLifecycleReadModel } from "@/lib/leads/estimateLifecycleReadModel";

/**
 * P1 Sprint 5 — the dedicated typed read model answering "is AI actually
 * running for this account, and did anything happen?" (§10/§15/§16 of the
 * directive). Every page that shows Estimate Closing OPERATIONAL state
 * (not recommendation-quality state — that's evaluationReadModel.ts, reused
 * here rather than re-derived) goes through this module. Nothing here
 * fakes a live value where the architecture only provides a structural
 * guarantee (toolCallsAttributable etc. are always 0), and nothing here
 * infers a status the data doesn't actually support: an empty telemetry
 * window is reported as "no_telemetry", never silently rendered as
 * "healthy."
 *
 * Split into a pure compute function (computeEstimateClosingOperations —
 * fully unit-testable with plain objects, no I/O) and an I/O wrapper
 * (getEstimateClosingOperations), mirroring
 * lib/leads/estimateLifecycleReadModel.ts's own compute/get split — that
 * split exists here for the SAME reason: getEstimateLifecycleReadModel
 * itself has no injectable deps (it calls createServerSupabaseClient()
 * transitively, which requires a real Next.js request context and cannot
 * run in plain Vitest — see that file's own precedent), so any wrapper
 * that calls it inherits the same untestability. The pure function below
 * is where this module's actual derivation logic lives and is tested.
 */

const SCAN_TELEMETRY_LIMIT = 20;
/** Bounded read of recent runs, wide enough to reliably find the most
 * recent Estimate Closing failure without an unbounded scan — matches the
 * same DEFAULT_LIMIT-class discipline every other read model in this
 * directory already applies. */
const RUN_LOOKBACK_LIMIT = 50;

export type ScanTelemetryStatus = "no_telemetry" | "observed" | "failure_recorded";

export type EstimateClosingOperations = {
  agentStatus: EstimateClosingAgentStatus;
  shadowEnabled: boolean;
  /** "no_telemetry" — nothing has ever been recorded for this tenant (never
   * rendered as healthy or unhealthy — absence of evidence is not evidence
   * of success). "observed" — the most recent scan telemetry event is a
   * completed one. "failure_recorded" — the most recent scan telemetry
   * event is a genuine scan-level failure. */
  scanTelemetryStatus: ScanTelemetryStatus;
  /** occurredAt of the single most recent scan telemetry event (completed
   * OR failed, whichever is newer) — null when scanTelemetryStatus is
   * "no_telemetry". */
  lastScanAt: string | null;
  /** Non-null only when scanTelemetryStatus === "observed". */
  latestScanCounts: ScanCompletedPayload | null;
  /** Non-null only when scanTelemetryStatus === "failure_recorded". */
  latestScanFailureCategory: string | null;
  /** Scan telemetry events read but whose payload didn't match the
   * expected shape — surfaced so a page can show "N telemetry records
   * couldn't be read" honestly instead of silently dropping them. */
  malformedScanTelemetryCount: number;
  /** Bounded-window figures — see evaluationReadModel.ts's own doc comment
   * on why these reflect the most recent DEFAULT_LIMIT recommendations,
   * not a lifetime total. */
  recommendationsGenerated: number;
  recommendationsAwaitingReview: number;
  latestSuccessfulRecommendationAt: string | null;
  modelFailureCount: number;
  /** The most recent Estimate Closing model_invocations row's error
   * category, when a failed run and its invocation can both be found —
   * null when there is no failure, or when the failure's own invocation
   * record cannot be located (never fabricated). */
  latestModelFailureCategory: string | null;
  malformedRecommendationOrReviewCount: number;
  lifecycleReadiness: { estimatesSent: number; activeFollowupSequences: number; stalledEligible: number };
  /** Always 0 — structural facts, not live query results. See
   * evaluationReadModel.ts's identical fields for the full explanation:
   * Shadow Mode has no toolPlan, never calls requestApproval(), and its
   * allowedTools is always []. */
  toolCallsAttributable: 0;
  approvalsAttributable: 0;
  customerActionsAttributable: 0;
};

function latestByOccurredAt<T extends { occurredAt: string }>(items: T[]): T | null {
  if (items.length === 0) return null;
  return items.reduce((latest, current) => (current.occurredAt > latest.occurredAt ? current : latest));
}

export type EstimateClosingOperationsInput = {
  agentStatus: EstimateClosingAgentStatus;
  shadowEnabled: boolean;
  recommendationsGenerated: number;
  recommendationsReviewed: number;
  latestSuccessfulRecommendationAt: string | null;
  modelFailureCount: number;
  /** Already resolved by the I/O wrapper (a two-step lookup: find the most
   * recent failed run, then read ITS invocation) — this function stays
   * pure by taking the resolved value rather than the run/invocation lists
   * themselves. */
  latestModelFailureCategory: string | null;
  malformedRecommendationOrReviewCount: number;
  lifecycleReadiness: { estimatesSent: number; activeFollowupSequences: number; stalledEligible: number };
  /** Raw (occurredAt, payload) pairs for estimate.closing_scan_completed /
   * estimate.closing_scan_failed events — parsing happens INSIDE this
   * function (via the same strict parsers scanTelemetry.ts exports), so a
   * malformed historical payload is safely skipped and counted here,
   * exactly once, in one place. */
  completedTelemetryEvents: Array<{ occurredAt: string; payload: unknown }>;
  failedTelemetryEvents: Array<{ occurredAt: string; payload: unknown }>;
};

/**
 * Pure — every field on the result is derived only from `input`. See the
 * module doc comment above for why this exists as a standalone function.
 */
export function computeEstimateClosingOperations(input: EstimateClosingOperationsInput): EstimateClosingOperations {
  let malformedScanTelemetryCount = 0;
  const parsedCompleted: Array<{ occurredAt: string; payload: ScanCompletedPayload }> = [];
  for (const event of input.completedTelemetryEvents) {
    const parsed = parsePersistedScanCompletedPayload(event.payload);
    if (parsed.ok) parsedCompleted.push({ occurredAt: event.occurredAt, payload: parsed.value });
    else malformedScanTelemetryCount += 1;
  }
  const parsedFailed: Array<{ occurredAt: string; errorCategory: string }> = [];
  for (const event of input.failedTelemetryEvents) {
    const parsed = parsePersistedScanFailedPayload(event.payload);
    if (parsed.ok) parsedFailed.push({ occurredAt: event.occurredAt, errorCategory: parsed.value.errorCategory });
    else malformedScanTelemetryCount += 1;
  }

  const latestCompleted = latestByOccurredAt(parsedCompleted);
  const latestFailed = latestByOccurredAt(parsedFailed);

  let scanTelemetryStatus: ScanTelemetryStatus = "no_telemetry";
  let lastScanAt: string | null = null;
  let latestScanCounts: ScanCompletedPayload | null = null;
  let latestScanFailureCategory: string | null = null;

  // Whichever of the two telemetry types is most recent wins — a failure
  // recorded AFTER a prior success must show as "failure_recorded", not be
  // masked by the earlier success (and vice versa).
  if (latestCompleted && (!latestFailed || latestCompleted.occurredAt >= latestFailed.occurredAt)) {
    scanTelemetryStatus = "observed";
    lastScanAt = latestCompleted.occurredAt;
    latestScanCounts = latestCompleted.payload;
  } else if (latestFailed) {
    scanTelemetryStatus = "failure_recorded";
    lastScanAt = latestFailed.occurredAt;
    latestScanFailureCategory = latestFailed.errorCategory;
  }

  return {
    agentStatus: input.agentStatus,
    shadowEnabled: input.shadowEnabled,
    scanTelemetryStatus,
    lastScanAt,
    latestScanCounts,
    latestScanFailureCategory,
    malformedScanTelemetryCount,
    recommendationsGenerated: input.recommendationsGenerated,
    recommendationsAwaitingReview: Math.max(0, input.recommendationsGenerated - input.recommendationsReviewed),
    latestSuccessfulRecommendationAt: input.latestSuccessfulRecommendationAt,
    modelFailureCount: input.modelFailureCount,
    latestModelFailureCategory: input.latestModelFailureCategory,
    malformedRecommendationOrReviewCount: input.malformedRecommendationOrReviewCount,
    lifecycleReadiness: input.lifecycleReadiness,
    toolCallsAttributable: 0,
    approvalsAttributable: 0,
    customerActionsAttributable: 0,
  };
}

export type OperationsReadModelDeps = {
  eventStore?: BusinessEventStore;
  runStore?: AgentRunStore;
  modelInvocationStore?: ModelInvocationStore;
  agentStore?: Pick<AgentStore, "listByTenant">;
};

export async function getEstimateClosingOperations(tenantId: string, deps: OperationsReadModelDeps = {}): Promise<EstimateClosingOperations> {
  const eventStore = deps.eventStore ?? new SupabaseBusinessEventStore();
  const runStore = deps.runStore ?? new SupabaseAgentRunStore();
  const modelInvocationStore = deps.modelInvocationStore ?? new SupabaseModelInvocationStore();
  const agentStore = deps.agentStore ?? new SupabaseAgentStore();

  const [agents, evaluation, lifecycle, completedEvents, failedEvents, runs] = await Promise.all([
    agentStore.listByTenant(tenantId),
    getEstimateClosingEvaluation(tenantId, { eventStore, runStore }),
    getEstimateLifecycleReadModel(tenantId),
    eventStore.listByTenant(tenantId, { eventType: "estimate.closing_scan_completed", limit: SCAN_TELEMETRY_LIMIT }),
    eventStore.listByTenant(tenantId, { eventType: "estimate.closing_scan_failed", limit: SCAN_TELEMETRY_LIMIT }),
    runStore.listByTenant(tenantId, { limit: RUN_LOOKBACK_LIMIT }),
  ]);

  // Latest model failure category — reuse the ALREADY-FETCHED bounded runs
  // list (never a new cross-tenant query, never a new ModelInvocationStore
  // method) to find the most recent failed Estimate Closing run, then read
  // ITS invocation's own error category.
  const failedRuns = runs.filter((run) => run.workflowId === ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID && run.status === "failed");
  let latestModelFailureCategory: string | null = null;
  if (failedRuns.length > 0) {
    const mostRecentFailedRun = failedRuns.reduce((latest, current) => {
      const latestAt = latest.completedAt ?? latest.createdAt;
      const currentAt = current.completedAt ?? current.createdAt;
      return currentAt > latestAt ? current : latest;
    });
    const invocations = await modelInvocationStore.listByAgentRun(tenantId, mostRecentFailedRun.id);
    const failedInvocation = [...invocations].reverse().find((inv) => inv.status === "failed");
    latestModelFailureCategory = failedInvocation?.errorCategory ?? null;
  }

  return computeEstimateClosingOperations({
    agentStatus: resolveEstimateClosingAgentStatus(agents),
    shadowEnabled: isEstimateClosingShadowEnabled(),
    recommendationsGenerated: evaluation.recommendationsGenerated,
    recommendationsReviewed: evaluation.recommendationsReviewed,
    latestSuccessfulRecommendationAt: evaluation.latestRecommendationAt,
    modelFailureCount: evaluation.modelFailureCount,
    latestModelFailureCategory,
    malformedRecommendationOrReviewCount: evaluation.skippedMalformedRecommendations + evaluation.skippedMalformedReviews,
    lifecycleReadiness: {
      estimatesSent: lifecycle.estimatesSent,
      activeFollowupSequences: lifecycle.activeFollowupSequences,
      stalledEligible: lifecycle.stalledEligible,
    },
    completedTelemetryEvents: completedEvents.map((e) => ({ occurredAt: e.occurredAt, payload: e.payload })),
    failedTelemetryEvents: failedEvents.map((e) => ({ occurredAt: e.occurredAt, payload: e.payload })),
  });
}
