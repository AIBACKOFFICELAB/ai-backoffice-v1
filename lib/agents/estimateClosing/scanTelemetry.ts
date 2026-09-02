import { emitEventSafely } from "@/lib/events/service";
import { BusinessEventStore } from "@/lib/events/store";
import { StalledScanResult, StalledEmission } from "./stalledScan";
import { EstimateClosingShadowOutcome } from "./shadowRunner";

/**
 * P1 Sprint 5 — durable, tenant-scoped Estimate Closing SCAN telemetry.
 * Closes the "cron ran and found zero candidates" vs. "cron never ran"
 * observability gap (see the P1 Sprint 5 directive's "Current architectural
 * gap"). Deliberately a separate module from stalledScan.ts/shadowRunner.ts:
 * every function here is PURE (no I/O) except the two emit* functions,
 * which are thin, best-effort wrappers around the existing emitEventSafely
 * convention — nothing here touches candidate selection, stall
 * determination, eligibility, or the model gateway.
 *
 * SCAN TELEMETRY IS NOT AN AGENT RUN. A scan-completed/scan-failed event is
 * an OPERATIONAL heartbeat — "the cron invocation that produced this record
 * ran, and here is what it observed" — never a business outcome, never a
 * recommendation, never evidence of reasoning. See docs/EVENT_SYSTEM.md and
 * OUTCOME_ATTRIBUTION.md's honesty discipline, extended here to scan
 * telemetry: this module creates zero agent_runs rows, zero
 * model_invocations rows, zero tool_calls rows, zero approvals rows, zero
 * outcomes rows — structurally, by never importing any of those stores.
 */

export type TenantScanSummary = {
  tenantId: string;
  candidatesScanned: number;
  stalledFound: number;
  /** Of stalledFound, how many were newly emitted THIS sweep (vs. already
   * existing from a previous run) — mirrors scanRoute.ts's existing
   * (previously global-only) newEventsThisSweep computation. */
  newlyStalled: number;
  shadowAttempts: number;
  succeeded: number;
  /** shadowOutcomes with status "skipped" and reason "already_processed" —
   * a healthy, expected outcome (retry-safety working as designed), kept
   * separate from `skipped` below so it's never misread as a problem. */
  alreadyProcessed: number;
  /** shadowOutcomes with status "skipped" for any OTHER reason
   * (feature_disabled / agent_missing / agent_inactive / not_eligible). */
  skipped: number;
  failed: number;
};

function emptyTenantScanSummary(tenantId: string): TenantScanSummary {
  return {
    tenantId,
    candidatesScanned: 0,
    stalledFound: 0,
    newlyStalled: 0,
    shadowAttempts: 0,
    succeeded: 0,
    alreadyProcessed: 0,
    skipped: 0,
    failed: 0,
  };
}

/**
 * Pure — takes the sweep's own already-computed results plus the
 * independently-known set of "relevant" tenant ids (tenants with a
 * registered AND active estimate_closing agent — the exact same criterion
 * shadowRunner.ts's own per-candidate gate already requires before any
 * model call; see AgentStore.listActiveByType). A tenant NOT in
 * `relevantTenantIds` gets no summary record at all, even if it happened to
 * have candidates in this sweep (their shadow outcomes, if any, already
 * carry their own agent_missing/agent_inactive skip reason unchanged from
 * today's behavior — this function only decides what gets a durable
 * TENANT-SCOPED telemetry record, never what gets scanned).
 *
 * Every relevant tenant gets a record, INCLUDING one with zero candidates
 * this sweep (Gate 6's critical regression case) — seeded before the loops
 * below run.
 */
export function computeTenantScanSummaries(
  scan: Pick<StalledScanResult, "candidatesScannedByTenant" | "stalledCandidates">,
  shadowOutcomes: Array<{ emission: StalledEmission; outcome: EstimateClosingShadowOutcome }>,
  relevantTenantIds: string[]
): TenantScanSummary[] {
  const relevantSet = new Set(relevantTenantIds);
  const summaries = new Map<string, TenantScanSummary>();

  for (const tenantId of Array.from(relevantSet)) {
    summaries.set(tenantId, emptyTenantScanSummary(tenantId));
  }

  for (const [tenantId, count] of Object.entries(scan.candidatesScannedByTenant)) {
    const summary = summaries.get(tenantId);
    if (summary) summary.candidatesScanned = count;
  }

  for (const emission of scan.stalledCandidates) {
    const summary = summaries.get(emission.tenantId);
    if (!summary) continue;
    summary.stalledFound += 1;
    if (emission.isNewEvent) summary.newlyStalled += 1;
  }

  for (const { emission, outcome } of shadowOutcomes) {
    const summary = summaries.get(emission.tenantId);
    if (!summary) continue;
    summary.shadowAttempts += 1;
    if (outcome.status === "succeeded") summary.succeeded += 1;
    else if (outcome.status === "failed") summary.failed += 1;
    else if (outcome.reason === "already_processed") summary.alreadyProcessed += 1;
    else summary.skipped += 1;
  }

  return Array.from(summaries.values());
}

export type ScanCompletedPayload = {
  scanId: string;
  candidatesScanned: number;
  stalledFound: number;
  newlyStalled: number;
  shadowAttempts: number;
  succeeded: number;
  alreadyProcessed: number;
  skipped: number;
  failed: number;
  durationMs: number | null;
};

export type ScanFailedPayload = {
  scanId: string;
  errorCategory: string;
  durationMs: number | null;
};

const SCAN_COMPLETED_NUMERIC_FIELDS = [
  "candidatesScanned",
  "stalledFound",
  "newlyStalled",
  "shadowAttempts",
  "succeeded",
  "alreadyProcessed",
  "skipped",
  "failed",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDurationMs(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

/**
 * Strict shape check against the PERSISTED completed-scan payload contract
 * (see emitScanCompletedTelemetry above, the only writer) — mirrors
 * recommendationReadModel.ts::parsePersistedRecommendationPayload's
 * discipline: a business_events row is free-text JSONB at the database
 * layer, so a malformed/historical payload is skipped and counted by the
 * caller (lib/agents/estimateClosing/operationsReadModel.ts), never trusted
 * or thrown on.
 */
export function parsePersistedScanCompletedPayload(payload: unknown): { ok: true; value: ScanCompletedPayload } | { ok: false } {
  if (!isRecord(payload)) return { ok: false };
  if (typeof payload.scanId !== "string" || !payload.scanId) return { ok: false };
  for (const field of SCAN_COMPLETED_NUMERIC_FIELDS) {
    const value = payload[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { ok: false };
  }
  if (!validDurationMs(payload.durationMs)) return { ok: false };

  return {
    ok: true,
    value: {
      scanId: payload.scanId,
      candidatesScanned: payload.candidatesScanned as number,
      stalledFound: payload.stalledFound as number,
      newlyStalled: payload.newlyStalled as number,
      shadowAttempts: payload.shadowAttempts as number,
      succeeded: payload.succeeded as number,
      alreadyProcessed: payload.alreadyProcessed as number,
      skipped: payload.skipped as number,
      failed: payload.failed as number,
      durationMs: payload.durationMs as number | null,
    },
  };
}

/** Strict shape check for the persisted scan-failed payload — same
 * discipline as parsePersistedScanCompletedPayload above. */
export function parsePersistedScanFailedPayload(payload: unknown): { ok: true; value: ScanFailedPayload } | { ok: false } {
  if (!isRecord(payload)) return { ok: false };
  if (typeof payload.scanId !== "string" || !payload.scanId) return { ok: false };
  if (typeof payload.errorCategory !== "string" || !payload.errorCategory) return { ok: false };
  if (!validDurationMs(payload.durationMs)) return { ok: false };

  return { ok: true, value: { scanId: payload.scanId, errorCategory: payload.errorCategory, durationMs: payload.durationMs as number | null } };
}

export type ScanTelemetryDeps = { eventStore?: BusinessEventStore };

export type TenantTelemetryWriteResult = { tenantId: string; ok: boolean };

/**
 * Best-effort, tenant-scoped emission of one estimate.closing_scan_completed
 * event per tenant summary — uses emitEventSafely (the SAME compatibility-
 * adapter convention lib/modules/missedCallRecovery/service.ts already
 * relies on), so a write failure or a hang past the shared telemetry
 * deadline can NEVER throw back into the caller, never re-runs the scan,
 * and never affects any other tenant's write (Gate 8). Returns per-tenant
 * ok/fail so the caller can report (never silently swallow) how many
 * writes actually landed, without ever including PII in that report.
 *
 * Every tenant's write runs CONCURRENTLY (Promise.all), not one-at-a-time
 * (Codex review finding on PR #24, P1): emitEventSafely's own per-call
 * deadline (TELEMETRY_DEADLINE_MS) already bounds ONE write's worst case,
 * but a serial loop still multiplies that bound by the tenant count during
 * a real event-store outage — with enough active tenants, that could
 * exceed the scan route's own Vercel function time budget, and every
 * tenant after the point of exhaustion would receive no telemetry attempt
 * at all, not even a recorded failure. Promise.all keeps each tenant's
 * write independent and bounded by the SAME single per-call deadline
 * regardless of how many tenants are being scanned, and still returns
 * results in the same order as `summaries` (Promise.all preserves input
 * order, not completion order).
 */
export async function emitScanCompletedTelemetry(
  scanId: string,
  summaries: TenantScanSummary[],
  durationMs: number,
  deps: ScanTelemetryDeps = {}
): Promise<TenantTelemetryWriteResult[]> {
  return Promise.all(
    summaries.map(async (summary): Promise<TenantTelemetryWriteResult> => {
      const event = await emitEventSafely(
        {
          tenantId: summary.tenantId,
          eventType: "estimate.closing_scan_completed",
          actorType: "system",
          correlationId: scanId,
          payload: {
            scanId,
            candidatesScanned: summary.candidatesScanned,
            stalledFound: summary.stalledFound,
            newlyStalled: summary.newlyStalled,
            shadowAttempts: summary.shadowAttempts,
            succeeded: summary.succeeded,
            alreadyProcessed: summary.alreadyProcessed,
            skipped: summary.skipped,
            failed: summary.failed,
            durationMs,
          },
        },
        deps.eventStore
      );
      return { tenantId: summary.tenantId, ok: event !== null };
    })
  );
}

/**
 * Fixed, sanitized failure taxonomy for a SCAN-level failure — mirrors
 * lib/ai/gateway.ts::normalizeProviderError's discipline: never the raw
 * thrown error's message (which could echo back arbitrary internal detail),
 * only a bounded category derived by checking for a known, FIXED error
 * message PREFIX this codebase itself controls (stalledScan.ts's own thrown
 * message), never the dynamic suffix.
 */
export type ScanFailureCategory = "read_failed" | "unknown";

const READ_FAILURE_PREFIX = "[estimate-closing] stalled scan read failed:";

export function categorizeScanFailure(error: unknown): ScanFailureCategory {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith(READ_FAILURE_PREFIX)) return "read_failed";
  return "unknown";
}

/**
 * Best-effort, tenant-scoped emission of one estimate.closing_scan_failed
 * event per ALREADY-KNOWN relevant tenant — only ever called once the
 * relevant-tenant set has been independently resolved (see
 * stalledScan.ts::runEstimateClosingShadowSweepWithTelemetry). If that
 * resolution itself failed, this function is never called — there is no
 * tenant list to attempt telemetry for, and Gate 8 explicitly forbids
 * pretending a failure event can always be persisted.
 *
 * Concurrent per-tenant writes (Codex review finding on PR #24, P1) — same
 * reasoning as emitScanCompletedTelemetry above: a serial loop multiplies
 * one write's worst-case latency by the tenant count during a real
 * event-store outage, which is exactly the scenario a SCAN failure is
 * already occurring alongside.
 */
export async function emitScanFailedTelemetry(
  scanId: string,
  relevantTenantIds: string[],
  errorCategory: ScanFailureCategory,
  durationMs: number,
  deps: ScanTelemetryDeps = {}
): Promise<TenantTelemetryWriteResult[]> {
  return Promise.all(
    relevantTenantIds.map(async (tenantId): Promise<TenantTelemetryWriteResult> => {
      const event = await emitEventSafely(
        {
          tenantId,
          eventType: "estimate.closing_scan_failed",
          actorType: "system",
          correlationId: scanId,
          payload: { scanId, errorCategory, durationMs },
        },
        deps.eventStore
      );
      return { tenantId, ok: event !== null };
    })
  );
}
