import { describe, it, expect } from "vitest";
import {
  computeTenantScanSummaries,
  emitScanCompletedTelemetry,
  emitScanFailedTelemetry,
  categorizeScanFailure,
  TenantScanSummary,
} from "./scanTelemetry";
import { StalledEmission } from "./stalledScan";
import { EstimateClosingShadowOutcome } from "./shadowRunner";
import { InMemoryBusinessEventStore, BusinessEventStore } from "@/lib/events/store";
import { BusinessEvent } from "@/lib/events/types";
import { EstimateClosingLeadContext, EstimateFollowupSequenceContext } from "./types";
import { randomUUID } from "crypto";

const TENANT_A = "tenant-a"; // active agent, zero candidates
const TENANT_B = "tenant-b"; // active agent, one candidate before Day 7 (not stalled)
const TENANT_C = "tenant-c"; // active agent, one stalled candidate, succeeded
const TENANT_D = "tenant-d"; // active agent, one stalled candidate, failed model run
const TENANT_UNKNOWN = "tenant-unregistered"; // has candidates but is NOT in the relevant set

function lead(overrides: Partial<EstimateClosingLeadContext> = {}): EstimateClosingLeadContext {
  return {
    id: "lead-1",
    tenantId: TENANT_C,
    status: "Estimate Sent",
    estimateAmount: 3000,
    serviceType: "Drain Cleaning",
    leadSource: "Website",
    urgency: "Flexible",
    ...overrides,
  };
}

function sequence(overrides: Partial<EstimateFollowupSequenceContext> = {}): EstimateFollowupSequenceContext {
  return {
    id: "seq-1",
    tenantId: TENANT_C,
    leadId: "lead-1",
    status: "completed",
    estimateSentAt: "2026-08-15T09:00:00Z",
    day7DueAt: "2026-08-22T09:00:00Z",
    lastReplyAt: null,
    ...overrides,
  };
}

function emission(tenantId: string, isNewEvent: boolean, overrides: Partial<StalledEmission> = {}): StalledEmission {
  return {
    tenantId,
    eventId: `evt-${tenantId}`,
    lead: lead({ tenantId }),
    sequence: sequence({ tenantId, leadId: "lead-1" }),
    isNewEvent,
    ...overrides,
  };
}

describe("computeTenantScanSummaries", () => {
  it("Tenant A: active agent, zero candidates — still gets a seeded, all-zero summary record", () => {
    const summaries = computeTenantScanSummaries(
      { candidatesScannedByTenant: {}, stalledCandidates: [] },
      [],
      [TENANT_A]
    );
    expect(summaries).toEqual<TenantScanSummary[]>([
      { tenantId: TENANT_A, candidatesScanned: 0, stalledFound: 0, newlyStalled: 0, shadowAttempts: 0, succeeded: 0, alreadyProcessed: 0, skipped: 0, failed: 0 },
    ]);
  });

  it("Tenant B: a candidate exists but is not yet stalled (before Day 7) — candidatesScanned counts it, stalledFound does not", () => {
    const summaries = computeTenantScanSummaries(
      { candidatesScannedByTenant: { [TENANT_B]: 1 }, stalledCandidates: [] },
      [],
      [TENANT_B]
    );
    expect(summaries[0]).toEqual<TenantScanSummary>({
      tenantId: TENANT_B,
      candidatesScanned: 1,
      stalledFound: 0,
      newlyStalled: 0,
      shadowAttempts: 0,
      succeeded: 0,
      alreadyProcessed: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("Tenant C: a stalled candidate that produced a successful recommendation", () => {
    const em = emission(TENANT_C, true);
    const outcome: EstimateClosingShadowOutcome = {
      status: "succeeded",
      agentRunId: "run-c",
      recommendationEventId: "rec-c",
      recommendation: {
        recommendation: "follow_up",
        confidence: 0.8,
        reasonCodes: ["no_response_since_sent"],
        suggestedChannel: "sms",
        suggestedTiming: "within_24_hours",
        opportunityValue: 3000,
        rationaleLength: 120,
      },
    };
    const summaries = computeTenantScanSummaries(
      { candidatesScannedByTenant: { [TENANT_C]: 1 }, stalledCandidates: [em] },
      [{ emission: em, outcome }],
      [TENANT_C]
    );
    expect(summaries[0]).toEqual<TenantScanSummary>({
      tenantId: TENANT_C,
      candidatesScanned: 1,
      stalledFound: 1,
      newlyStalled: 1,
      shadowAttempts: 1,
      succeeded: 1,
      alreadyProcessed: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("Tenant D: a stalled candidate whose model run failed", () => {
    const em = emission(TENANT_D, true);
    const outcome: EstimateClosingShadowOutcome = { status: "failed", agentRunId: "run-d", failureReason: "model gateway failed: timeout" };
    const summaries = computeTenantScanSummaries(
      { candidatesScannedByTenant: { [TENANT_D]: 1 }, stalledCandidates: [em] },
      [{ emission: em, outcome }],
      [TENANT_D]
    );
    expect(summaries[0]).toEqual<TenantScanSummary>({
      tenantId: TENANT_D,
      candidatesScanned: 1,
      stalledFound: 1,
      newlyStalled: 1,
      shadowAttempts: 1,
      succeeded: 0,
      alreadyProcessed: 0,
      skipped: 0,
      failed: 1,
    });
  });

  it("an already-processed retry attempt is counted separately from a generic skip", () => {
    const em = emission(TENANT_C, false);
    const outcome: EstimateClosingShadowOutcome = { status: "skipped", reason: "already_processed" };
    const summaries = computeTenantScanSummaries(
      { candidatesScannedByTenant: { [TENANT_C]: 1 }, stalledCandidates: [em] },
      [{ emission: em, outcome }],
      [TENANT_C]
    );
    expect(summaries[0].alreadyProcessed).toBe(1);
    expect(summaries[0].skipped).toBe(0);
    expect(summaries[0].newlyStalled).toBe(0); // isNewEvent: false
  });

  it("a generic skip reason (agent_inactive, agent_missing, feature_disabled, not_eligible) is counted as skipped, not alreadyProcessed", () => {
    for (const reason of ["agent_inactive", "agent_missing", "feature_disabled", "not_eligible"] as const) {
      const em = emission(TENANT_C, true);
      const outcome: EstimateClosingShadowOutcome = { status: "skipped", reason };
      const summaries = computeTenantScanSummaries(
        { candidatesScannedByTenant: { [TENANT_C]: 1 }, stalledCandidates: [em] },
        [{ emission: em, outcome }],
        [TENANT_C]
      );
      expect(summaries[0].skipped).toBe(1);
      expect(summaries[0].alreadyProcessed).toBe(0);
    }
  });

  it("prove no tenant's telemetry contains another tenant's counts — all four tenants scanned in one sweep stay fully isolated", () => {
    const emC = emission(TENANT_C, true);
    const outcomeC: EstimateClosingShadowOutcome = {
      status: "succeeded",
      agentRunId: "run-c",
      recommendationEventId: "rec-c",
      recommendation: { recommendation: "follow_up", confidence: 0.9, reasonCodes: [], suggestedChannel: "sms", suggestedTiming: null, opportunityValue: 3000, rationaleLength: 10 },
    };
    const emD = emission(TENANT_D, true);
    const outcomeD: EstimateClosingShadowOutcome = { status: "failed", agentRunId: "run-d", failureReason: "model gateway failed: timeout" };

    const summaries = computeTenantScanSummaries(
      {
        candidatesScannedByTenant: { [TENANT_A]: 0, [TENANT_B]: 1, [TENANT_C]: 1, [TENANT_D]: 1 },
        stalledCandidates: [emC, emD],
      },
      [
        { emission: emC, outcome: outcomeC },
        { emission: emD, outcome: outcomeD },
      ],
      [TENANT_A, TENANT_B, TENANT_C, TENANT_D]
    );

    const byTenant = new Map(summaries.map((s) => [s.tenantId, s]));
    expect(byTenant.get(TENANT_A)).toEqual<TenantScanSummary>({
      tenantId: TENANT_A, candidatesScanned: 0, stalledFound: 0, newlyStalled: 0, shadowAttempts: 0, succeeded: 0, alreadyProcessed: 0, skipped: 0, failed: 0,
    });
    expect(byTenant.get(TENANT_B)).toEqual<TenantScanSummary>({
      tenantId: TENANT_B, candidatesScanned: 1, stalledFound: 0, newlyStalled: 0, shadowAttempts: 0, succeeded: 0, alreadyProcessed: 0, skipped: 0, failed: 0,
    });
    expect(byTenant.get(TENANT_C)?.succeeded).toBe(1);
    expect(byTenant.get(TENANT_C)?.failed).toBe(0);
    expect(byTenant.get(TENANT_D)?.failed).toBe(1);
    expect(byTenant.get(TENANT_D)?.succeeded).toBe(0);
    expect(summaries.length).toBe(4);
  });

  it("a tenant NOT in the relevant set gets no telemetry record at all, even if it had real candidates this sweep", () => {
    const em = emission(TENANT_UNKNOWN, true);
    const outcome: EstimateClosingShadowOutcome = { status: "skipped", reason: "agent_missing" };
    const summaries = computeTenantScanSummaries(
      { candidatesScannedByTenant: { [TENANT_UNKNOWN]: 3 }, stalledCandidates: [em] },
      [{ emission: em, outcome }],
      [TENANT_A] // TENANT_UNKNOWN deliberately not relevant
    );
    expect(summaries.find((s) => s.tenantId === TENANT_UNKNOWN)).toBeUndefined();
    expect(summaries).toEqual<TenantScanSummary[]>([
      { tenantId: TENANT_A, candidatesScanned: 0, stalledFound: 0, newlyStalled: 0, shadowAttempts: 0, succeeded: 0, alreadyProcessed: 0, skipped: 0, failed: 0 },
    ]);
  });

  it("empty relevant-tenant set produces zero summaries, never a fabricated global row", () => {
    const summaries = computeTenantScanSummaries({ candidatesScannedByTenant: {}, stalledCandidates: [] }, [], []);
    expect(summaries).toEqual([]);
  });
});

describe("emitScanCompletedTelemetry", () => {
  it("writes exactly one estimate.closing_scan_completed event per tenant summary, tenant-scoped and correlated by scanId", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const summaries: TenantScanSummary[] = [
      { tenantId: TENANT_A, candidatesScanned: 0, stalledFound: 0, newlyStalled: 0, shadowAttempts: 0, succeeded: 0, alreadyProcessed: 0, skipped: 0, failed: 0 },
      { tenantId: TENANT_B, candidatesScanned: 2, stalledFound: 1, newlyStalled: 1, shadowAttempts: 1, succeeded: 1, alreadyProcessed: 0, skipped: 0, failed: 0 },
    ];

    const results = await emitScanCompletedTelemetry("scan-123", summaries, 842, { eventStore });
    expect(results).toEqual([
      { tenantId: TENANT_A, ok: true },
      { tenantId: TENANT_B, ok: true },
    ]);

    const eventsA = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_scan_completed" });
    const eventsB = await eventStore.listByTenant(TENANT_B, { eventType: "estimate.closing_scan_completed" });
    expect(eventsA.length).toBe(1);
    expect(eventsB.length).toBe(1);
    expect(eventsA[0].correlationId).toBe("scan-123");
    expect(eventsB[0].correlationId).toBe("scan-123");
    expect(eventsA[0].payload).toEqual({
      scanId: "scan-123",
      candidatesScanned: 0,
      stalledFound: 0,
      newlyStalled: 0,
      shadowAttempts: 0,
      succeeded: 0,
      alreadyProcessed: 0,
      skipped: 0,
      failed: 0,
      durationMs: 842,
    });
    expect(eventsB[0].payload.candidatesScanned).toBe(2);
    expect(eventsB[0].payload.succeeded).toBe(1);
  });

  it("never includes PII — no customer identifiers, no rationale, no raw model output, in any completed-telemetry payload", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const summaries: TenantScanSummary[] = [
      { tenantId: TENANT_C, candidatesScanned: 1, stalledFound: 1, newlyStalled: 1, shadowAttempts: 1, succeeded: 1, alreadyProcessed: 0, skipped: 0, failed: 0 },
    ];
    await emitScanCompletedTelemetry("scan-pii-check", summaries, 100, { eventStore });
    const [event] = await eventStore.listByTenant(TENANT_C, { eventType: "estimate.closing_scan_completed" });
    const serialized = JSON.stringify(event.payload);
    expect(serialized).not.toMatch(/customerName|phone|email|serviceAddress|jobDescription|customerNotes|internalNotes|rationale/i);
  });

  it("writes every tenant's telemetry CONCURRENTLY, not serially (Codex review finding on PR #24, P1)", async () => {
    // Deterministic proof, not a timing assertion: an insert that only
    // resolves once every expected caller has entered proves overlap
    // without depending on wall-clock thresholds (which would be flaky in
    // CI). A serial (for-await) implementation would deadlock here — the
    // second insert() call would never even START until the first one's
    // Promise resolves, and it can't resolve until a SECOND call has
    // already entered.
    let inFlight = 0;
    let maxInFlight = 0;
    const releasers: Array<() => void> = [];
    const eventStore: BusinessEventStore = {
      async insert(input) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => releasers.push(resolve));
        inFlight -= 1;
        const now = new Date().toISOString();
        const event: BusinessEvent = {
          id: randomUUID(),
          tenantId: input.tenantId,
          eventType: input.eventType,
          actorType: input.actorType ?? "system",
          actorId: input.actorId ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          correlationId: input.correlationId ?? randomUUID(),
          causationId: input.causationId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          payload: input.payload ?? {},
          metadata: input.metadata ?? {},
          occurredAt: now,
          createdAt: now,
        };
        return { event, deduped: false };
      },
      async listByTenant() {
        return [];
      },
      async getById() {
        return null;
      },
    };

    const summaries: TenantScanSummary[] = [TENANT_A, TENANT_B, TENANT_C].map((tenantId) => ({
      tenantId,
      candidatesScanned: 0,
      stalledFound: 0,
      newlyStalled: 0,
      shadowAttempts: 0,
      succeeded: 0,
      alreadyProcessed: 0,
      skipped: 0,
      failed: 0,
    }));

    const pending = emitScanCompletedTelemetry("scan-concurrent", summaries, 10, { eventStore });
    // Give the event loop a tick to let every concurrent insert() actually
    // start before releasing any of them.
    await new Promise((resolve) => setImmediate(resolve));
    expect(maxInFlight).toBe(3); // all 3 tenants' writes were in flight simultaneously
    releasers.forEach((release) => release());
    const results = await pending;
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
  });
});

describe("emitScanFailedTelemetry", () => {
  it("writes a sanitized, tenant-scoped failure record per already-known relevant tenant, never the raw error text", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const results = await emitScanFailedTelemetry("scan-fail-1", [TENANT_A, TENANT_B], "read_failed", 55, { eventStore });
    expect(results).toEqual([
      { tenantId: TENANT_A, ok: true },
      { tenantId: TENANT_B, ok: true },
    ]);

    const [eventA] = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_scan_failed" });
    expect(eventA.payload).toEqual({ scanId: "scan-fail-1", errorCategory: "read_failed", durationMs: 55 });
  });
});

describe("categorizeScanFailure", () => {
  it("recognizes the fixed stalled-scan read-failure prefix without leaking the dynamic suffix", () => {
    const error = new Error("[estimate-closing] stalled scan read failed: relation \"estimate_followup_sequences\" does not exist");
    expect(categorizeScanFailure(error)).toBe("read_failed");
  });

  it("falls back to 'unknown' for anything else, including a non-Error throw", () => {
    expect(categorizeScanFailure(new Error("some other failure"))).toBe("unknown");
    expect(categorizeScanFailure("a raw string throw")).toBe("unknown");
    expect(categorizeScanFailure(null)).toBe("unknown");
  });
});
