import { describe, it, expect, vi } from "vitest";
import {
  scanForStalledEstimates,
  runEstimateClosingShadowSweep,
  runEstimateClosingShadowSweepWithTelemetry,
  InMemorySequenceWithLeadReader,
  buildStalledIdempotencyKey,
} from "./stalledScan";
import { InMemoryBusinessEventStore } from "@/lib/events/store";
import { InMemoryAgentStore } from "../agentStore";
import { InMemoryAgentRunStore } from "../runStore";
import { AiGateway } from "@/lib/ai/gateway";
import { InMemoryModelInvocationStore } from "@/lib/ai/store";
import { MockChatProvider } from "@/lib/ai/providers/mock";
import { ChatProvider, ChatCompleteParams, ChatCompleteResult } from "@/lib/ai/providers/types";
import { EstimateClosingLeadContext, EstimateFollowupSequenceContext } from "./types";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const NOW = new Date("2026-08-30T12:00:00Z");

const VALID_RESPONSE = JSON.stringify({
  recommendation: "follow_up",
  confidence: 0.7,
  reasonCodes: ["no_response_since_sent"],
  rationale: "No reply since the estimate was sent and the sequence has completed.",
  suggestedChannel: "sms",
  suggestedTiming: "within_3_days",
});

class FixedTextProvider implements ChatProvider {
  id = "mock";
  constructor(private readonly text: string) {}
  async complete(_params: ChatCompleteParams): Promise<ChatCompleteResult> {
    return { text: this.text, inputTokens: 10, outputTokens: 10 };
  }
}

function candidate(
  overrides: { lead?: Partial<EstimateClosingLeadContext>; sequence?: Partial<EstimateFollowupSequenceContext> } = {}
) {
  const lead: EstimateClosingLeadContext = {
    id: "lead-1",
    tenantId: TENANT_A,
    status: "Estimate Sent",
    estimateAmount: 3000,
    serviceType: "Drain Cleaning",
    leadSource: "Website",
    urgency: "Flexible",
    ...overrides.lead,
  };
  const sequence: EstimateFollowupSequenceContext = {
    id: "seq-1",
    tenantId: lead.tenantId,
    leadId: lead.id,
    status: "completed",
    estimateSentAt: "2026-08-15T09:00:00Z",
    day7DueAt: "2026-08-22T09:00:00Z", // well before NOW — stalled
    lastReplyAt: null,
    ...overrides.sequence,
  };
  return { lead, sequence };
}

describe("scanForStalledEstimates", () => {
  it("emits estimate.stalled for a genuinely stalled candidate", async () => {
    const reader = new InMemorySequenceWithLeadReader([candidate()]);
    const eventStore = new InMemoryBusinessEventStore();

    const result = await scanForStalledEstimates({ reader, eventStore, now: NOW });

    expect(result.candidatesScanned).toBe(1);
    expect(result.stalledFound).toBe(1);
    expect(result.stalledCandidates.length).toBe(1);
    expect(result.stalledCandidates[0].isNewEvent).toBe(true);

    const events = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.stalled" });
    expect(events.length).toBe(1);
    expect(events[0].idempotencyKey).toBe(buildStalledIdempotencyKey("seq-1"));
    expect(events[0].payload.customerName).toBeUndefined();
    expect(events[0].payload.phone).toBeUndefined();
  });

  it("skips a candidate that is not yet stalled (Day 7 threshold not reached)", async () => {
    const reader = new InMemorySequenceWithLeadReader([candidate({ sequence: { day7DueAt: "2099-01-01T00:00:00Z" } })]);
    const eventStore = new InMemoryBusinessEventStore();

    const result = await scanForStalledEstimates({ reader, eventStore, now: NOW });
    expect(result.stalledFound).toBe(0);
    expect(result.stalledCandidates.length).toBe(0);
    expect((await eventStore.listByTenant(TENANT_A)).length).toBe(0);
  });

  it("skips an ineligible candidate (already won) even if the timing would otherwise qualify", async () => {
    const reader = new InMemorySequenceWithLeadReader([candidate({ lead: { status: "Won" } })]);
    const eventStore = new InMemoryBusinessEventStore();

    const result = await scanForStalledEstimates({ reader, eventStore, now: NOW });
    expect(result.stalledFound).toBe(0);
  });

  it("does not re-emit the estimate.stalled event on a second scan, but still reports the estimate as (still) stalled", async () => {
    const reader = new InMemorySequenceWithLeadReader([candidate()]);
    const eventStore = new InMemoryBusinessEventStore();

    const first = await scanForStalledEstimates({ reader, eventStore, now: NOW });
    const second = await scanForStalledEstimates({ reader, eventStore, now: new Date(NOW.getTime() + 1000 * 60 * 60) });

    expect(first.stalledCandidates[0].isNewEvent).toBe(true);
    // Second run still correctly reports the estimate as stalled, and still
    // includes it in stalledCandidates (so a not-yet-successfully-processed
    // estimate can be retried — see runEstimateClosingShadowSweep below) —
    // but the underlying event is NOT re-emitted; both candidates carry the
    // SAME event id.
    expect(second.stalledFound).toBe(1);
    expect(second.stalledCandidates.length).toBe(1);
    expect(second.stalledCandidates[0].isNewEvent).toBe(false);
    expect(second.stalledCandidates[0].eventId).toBe(first.stalledCandidates[0].eventId);

    const events = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.stalled" });
    expect(events.length).toBe(1);
  });

  it("keeps two tenants' stalled events fully isolated from one another", async () => {
    const rowA = candidate({ lead: { tenantId: TENANT_A, id: "lead-a" }, sequence: { tenantId: TENANT_A, leadId: "lead-a", id: "seq-a" } });
    const rowB = candidate({ lead: { tenantId: TENANT_B, id: "lead-b" }, sequence: { tenantId: TENANT_B, leadId: "lead-b", id: "seq-b" } });
    const reader = new InMemorySequenceWithLeadReader([rowA, rowB]);
    const eventStore = new InMemoryBusinessEventStore();

    const result = await scanForStalledEstimates({ reader, eventStore, now: NOW });
    expect(result.stalledFound).toBe(2);

    const eventsA = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.stalled" });
    const eventsB = await eventStore.listByTenant(TENANT_B, { eventType: "estimate.stalled" });
    expect(eventsA.length).toBe(1);
    expect(eventsB.length).toBe(1);
    expect(eventsA[0].tenantId).toBe(TENANT_A);
    expect(eventsB[0].tenantId).toBe(TENANT_B);
  });
});

describe("runEstimateClosingShadowSweep", () => {
  it("retries a transient failure on a later sweep, then stops retrying once it succeeds (Codex P1 finding)", async () => {
    const reader = new InMemorySequenceWithLeadReader([candidate()]);
    const eventStore = new InMemoryBusinessEventStore();
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();

    await agentStore.create({
      tenantId: TENANT_A,
      agentType: "estimate_closing",
      name: "Estimate Closing Agent",
      status: "active",
      allowedTools: [],
      readScopes: [],
      writeScopes: [],
    });

    // Phase 1: the provider returns invalid JSON — a genuine (if synthetic)
    // gateway failure. Old design: the estimate.stalled event's own
    // permanent idempotency key would mean this estimate could NEVER be
    // retried again. New design: the failure is retryable because nothing
    // has SUCCEEDED yet.
    const failingGateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });
    const attempt1 = await runEstimateClosingShadowSweep(
      { reader, eventStore, now: NOW },
      { agentStore, runStore, eventStore, gateway: failingGateway, isEnabled: () => true }
    );
    expect(attempt1.shadowOutcomes.length).toBe(1);
    expect(attempt1.shadowOutcomes[0].outcome.status).toBe("failed");
    expect((await runStore.listByTenant(TENANT_A)).length).toBe(1);

    // Phase 2: a later sweep, same underlying failure — MUST be retried,
    // not silently skipped, because the estimate.stalled event can never
    // be re-emitted (same idempotency key) and nothing has succeeded yet.
    const attempt2 = await runEstimateClosingShadowSweep(
      { reader, eventStore, now: new Date(NOW.getTime() + 1000 * 60 * 60) },
      { agentStore, runStore, eventStore, gateway: failingGateway, isEnabled: () => true }
    );
    expect(attempt2.shadowOutcomes.length).toBe(1);
    expect(attempt2.shadowOutcomes[0].outcome.status).toBe("failed");
    expect((await runStore.listByTenant(TENANT_A)).length).toBe(2);

    // Phase 3: whatever was transiently wrong is now fixed — this sweep
    // succeeds.
    const workingGateway = new AiGateway({
      chatProviders: { mock: new FixedTextProvider(VALID_RESPONSE) },
      invocationStore: new InMemoryModelInvocationStore(),
    });
    const attempt3 = await runEstimateClosingShadowSweep(
      { reader, eventStore, now: new Date(NOW.getTime() + 2 * 1000 * 60 * 60) },
      { agentStore, runStore, eventStore, gateway: workingGateway, isEnabled: () => true }
    );
    expect(attempt3.shadowOutcomes.length).toBe(1);
    expect(attempt3.shadowOutcomes[0].outcome.status).toBe("succeeded");
    expect((await runStore.listByTenant(TENANT_A)).length).toBe(3);

    // Phase 4: now that a run has actually succeeded for this estimate, a
    // later sweep must NOT attempt it again — no fourth run, no repeat
    // model call for an already-closed-out opportunity.
    const attempt4 = await runEstimateClosingShadowSweep(
      { reader, eventStore, now: new Date(NOW.getTime() + 3 * 1000 * 60 * 60) },
      { agentStore, runStore, eventStore, gateway: workingGateway, isEnabled: () => true }
    );
    expect(attempt4.shadowOutcomes.length).toBe(1);
    expect(attempt4.shadowOutcomes[0].outcome).toEqual({ status: "skipped", reason: "already_processed" });
    expect((await runStore.listByTenant(TENANT_A)).length).toBe(3); // unchanged

    const recommendationEvents = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_recommendation_generated" });
    expect(recommendationEvents.length).toBe(1); // exactly one recommendation, from the one successful run
  });

  it("retries an estimate that was skipped because the tenant's agent wasn't active yet at first detection (Codex P1 finding)", async () => {
    const reader = new InMemorySequenceWithLeadReader([candidate()]);
    const eventStore = new InMemoryBusinessEventStore();
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const gateway = new AiGateway({
      chatProviders: { mock: new FixedTextProvider(VALID_RESPONSE) },
      invocationStore: new InMemoryModelInvocationStore(),
    });

    // No agent_closing agent seeded yet at the time of the first sweep.
    const attempt1 = await runEstimateClosingShadowSweep(
      { reader, eventStore, now: NOW },
      { agentStore, runStore, eventStore, gateway, isEnabled: () => true }
    );
    expect(attempt1.shadowOutcomes[0].outcome).toEqual({ status: "skipped", reason: "agent_missing" });
    expect((await runStore.listByTenant(TENANT_A)).length).toBe(0);

    // The founder activates the agent between sweeps.
    await agentStore.create({
      tenantId: TENANT_A,
      agentType: "estimate_closing",
      name: "Estimate Closing Agent",
      status: "active",
      allowedTools: [],
      readScopes: [],
      writeScopes: [],
    });

    const attempt2 = await runEstimateClosingShadowSweep(
      { reader, eventStore, now: new Date(NOW.getTime() + 1000 * 60 * 60) },
      { agentStore, runStore, eventStore, gateway, isEnabled: () => true }
    );
    expect(attempt2.shadowOutcomes[0].outcome.status).toBe("succeeded");
    expect((await runStore.listByTenant(TENANT_A)).length).toBe(1);
  });
});

describe("runEstimateClosingShadowSweepWithTelemetry (P1 Sprint 5)", () => {
  async function activeAgentStore(tenantId = TENANT_A) {
    const agentStore = new InMemoryAgentStore();
    await agentStore.create({
      tenantId,
      agentType: "estimate_closing",
      name: "Estimate Closing Agent",
      status: "active",
      allowedTools: [],
      readScopes: [],
      writeScopes: [],
    });
    return agentStore;
  }

  it("active tenant + zero candidates creates exactly one durable estimate.closing_scan_completed record, and zero agent_run/model_invocation/recommendation/tool_call/approval/outcome", async () => {
    const reader = new InMemorySequenceWithLeadReader([]); // zero candidates
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();
    const agentStore = await activeAgentStore();

    const result = await runEstimateClosingShadowSweepWithTelemetry(
      { reader, eventStore, now: NOW },
      { agentStore, runStore, eventStore, isEnabled: () => true },
      { agentStore, telemetry: { eventStore } }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.sweep.scan.candidatesScanned).toBe(0);
    expect(result.sweep.shadowOutcomes.length).toBe(0);
    expect(result.tenantSummaries).toEqual([
      { tenantId: TENANT_A, candidatesScanned: 0, stalledFound: 0, newlyStalled: 0, shadowAttempts: 0, succeeded: 0, alreadyProcessed: 0, skipped: 0, failed: 0 },
    ]);
    expect(result.telemetry).toEqual({ status: "recorded", attemptedTenantIds: [TENANT_A] });

    const completedEvents = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_scan_completed" });
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0].payload.candidatesScanned).toBe(0);
    expect(completedEvents[0].correlationId).toBe(result.scanId);

    // Structural zero-touch proof — nothing here has a store to create any
    // of these in, but assert the counts explicitly regardless.
    expect((await runStore.listByTenant(TENANT_A)).length).toBe(0);
    const recommendationEvents = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_recommendation_generated" });
    expect(recommendationEvents.length).toBe(0);
  });

  it("multi-tenant: an active tenant with zero candidates and an active tenant with a real stalled candidate each get their OWN isolated telemetry record in the same sweep", async () => {
    const rowB = candidate({ lead: { tenantId: TENANT_B, id: "lead-b" }, sequence: { tenantId: TENANT_B, leadId: "lead-b", id: "seq-b" } });
    const reader = new InMemorySequenceWithLeadReader([rowB]); // only tenant B has a candidate
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();
    const agentStore = new InMemoryAgentStore();
    await agentStore.create({ tenantId: TENANT_A, agentType: "estimate_closing", name: "A", status: "active", allowedTools: [], readScopes: [], writeScopes: [] });
    await agentStore.create({ tenantId: TENANT_B, agentType: "estimate_closing", name: "B", status: "active", allowedTools: [], readScopes: [], writeScopes: [] });
    const gateway = new AiGateway({ chatProviders: { mock: new FixedTextProvider(VALID_RESPONSE) }, invocationStore: new InMemoryModelInvocationStore() });

    const result = await runEstimateClosingShadowSweepWithTelemetry(
      { reader, eventStore, now: NOW },
      { agentStore, runStore, eventStore, gateway, isEnabled: () => true },
      { agentStore, telemetry: { eventStore } }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.tenantSummaries).not.toBeNull();
    const byTenant = new Map((result.tenantSummaries ?? []).map((s) => [s.tenantId, s]));
    expect(byTenant.get(TENANT_A)?.candidatesScanned).toBe(0);
    expect(byTenant.get(TENANT_A)?.shadowAttempts).toBe(0);
    expect(byTenant.get(TENANT_B)?.candidatesScanned).toBe(1);
    expect(byTenant.get(TENANT_B)?.stalledFound).toBe(1);
    expect(byTenant.get(TENANT_B)?.succeeded).toBe(1);

    const completedA = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_scan_completed" });
    const completedB = await eventStore.listByTenant(TENANT_B, { eventType: "estimate.closing_scan_completed" });
    expect(completedA.length).toBe(1);
    expect(completedB.length).toBe(1);
    expect(completedA[0].payload.candidatesScanned).toBe(0);
    expect(completedB[0].payload.candidatesScanned).toBe(1);
    expect(completedB[0].payload.succeeded).toBe(1);
  });

  it("a telemetry write failure does not re-run the scan, does not trigger a second model call, and does not convert a successful scan into a failure — reported as 'partial'", async () => {
    const reader = new InMemorySequenceWithLeadReader([candidate()]);
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();
    const agentStore = await activeAgentStore();
    const gateway = new AiGateway({ chatProviders: { mock: new FixedTextProvider(VALID_RESPONSE) }, invocationStore: new InMemoryModelInvocationStore() });

    // A telemetry-only event store whose insert always fails — the REAL
    // scan/shadow path still uses the healthy `eventStore` above.
    const failingTelemetryStore = new InMemoryBusinessEventStore();
    vi.spyOn(failingTelemetryStore, "insert").mockRejectedValue(new Error("telemetry db unavailable"));

    const result = await runEstimateClosingShadowSweepWithTelemetry(
      { reader, eventStore, now: NOW },
      { agentStore, runStore, eventStore, gateway, isEnabled: () => true },
      { agentStore, telemetry: { eventStore: failingTelemetryStore } }
    );

    expect(result.ok).toBe(true); // the SCAN succeeded — telemetry failure never flips this
    if (!result.ok) throw new Error("expected ok");
    expect(result.telemetry).toEqual({ status: "partial", attemptedTenantIds: [TENANT_A], failedTenantIds: [TENANT_A] });
    expect(result.sweep.shadowOutcomes.length).toBe(1);
    expect(result.sweep.shadowOutcomes[0].outcome.status).toBe("succeeded");
    // Exactly one run, one recommendation — the failed telemetry write never
    // caused a retry of the reasoning itself.
    expect((await runStore.listByTenant(TENANT_A)).length).toBe(1);
    const recommendationEvents = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_recommendation_generated" });
    expect(recommendationEvents.length).toBe(1);
  });

  it("a genuine scan failure (candidate read throws) is reported as ok:false with a sanitized error category, and still attempts tenant-scoped failure telemetry for already-known relevant tenants", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const agentStore = await activeAgentStore();
    const failingReader = { listCandidates: vi.fn().mockRejectedValue(new Error("[estimate-closing] stalled scan read failed: connection reset")) };

    const result = await runEstimateClosingShadowSweepWithTelemetry(
      { reader: failingReader, eventStore, now: NOW },
      { eventStore, isEnabled: () => true },
      { agentStore, telemetry: { eventStore } }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errorCategory).toBe("read_failed");
    expect(result.telemetry).toEqual({ status: "recorded", attemptedTenantIds: [TENANT_A] }); // one relevant tenant, one successful failure-telemetry write

    const failedEvents = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_scan_failed" });
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].payload).toEqual({ scanId: result.scanId, errorCategory: "read_failed", durationMs: expect.any(Number) });
  });

  // --- Founder review, PR #24: TELEMETRY MUST NEVER GATE SHADOW EXECUTION ---

  it("tenant-discovery failure + otherwise-successful scan: the sweep STILL runs exactly once, the successful Shadow outcome is preserved, and telemetry is honestly reported unavailable — never a fabricated tenant, never a blocked scan", async () => {
    const reader = new InMemorySequenceWithLeadReader([candidate()]);
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();
    const agentStore = await activeAgentStore();
    const gateway = new AiGateway({ chatProviders: { mock: new FixedTextProvider(VALID_RESPONSE) }, invocationStore: new InMemoryModelInvocationStore() });
    const failingDiscoveryStore = { listActiveByType: vi.fn().mockRejectedValue(new Error("agents table unavailable")) };

    const result = await runEstimateClosingShadowSweepWithTelemetry(
      { reader, eventStore, now: NOW },
      { agentStore, runStore, eventStore, gateway, isEnabled: () => true },
      { agentStore: failingDiscoveryStore, telemetry: { eventStore } }
    );

    // The real Shadow scan ran and genuinely succeeded — a telemetry-only
    // infrastructure failure (can't enumerate relevant tenants) must NEVER
    // prevent the actual reasoning path from running or being reported.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.sweep.shadowOutcomes.length).toBe(1);
    expect(result.sweep.shadowOutcomes[0].outcome.status).toBe("succeeded");
    expect(result.tenantSummaries).toBeNull(); // nothing to compute per-tenant summaries from
    expect(result.telemetry).toEqual({ status: "unavailable" });

    // Exactly one run — proving the sweep was attempted exactly once, not
    // retried because telemetry discovery failed first.
    expect((await runStore.listByTenant(TENANT_A)).length).toBe(1);
    const recommendationEvents = await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_recommendation_generated" });
    expect(recommendationEvents.length).toBe(1);

    // No fabricated telemetry event of either kind for any tenant.
    expect((await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_scan_completed" })).length).toBe(0);
    expect((await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_scan_failed" })).length).toBe(0);
  });

  it("tenant-discovery failure + a genuine scan failure: the scan still runs exactly once, its failure is preserved (never masked as success), and telemetry is honestly reported unavailable", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const failingReader = { listCandidates: vi.fn().mockRejectedValue(new Error("[estimate-closing] stalled scan read failed: connection reset")) };
    const failingDiscoveryStore = { listActiveByType: vi.fn().mockRejectedValue(new Error("agents table unavailable")) };

    const result = await runEstimateClosingShadowSweepWithTelemetry(
      { reader: failingReader, eventStore, now: NOW },
      { eventStore, isEnabled: () => true },
      { agentStore: failingDiscoveryStore, telemetry: { eventStore } }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errorCategory).toBe("read_failed"); // the SCAN's own failure category, not the discovery failure's
    expect(result.telemetry).toEqual({ status: "unavailable" });
    expect(failingReader.listCandidates).toHaveBeenCalledTimes(1); // the scan was genuinely attempted, exactly once

    // No tenant is known, so no fabricated failure event anywhere.
    expect((await eventStore.listByTenant(TENANT_A, { eventType: "estimate.closing_scan_failed" })).length).toBe(0);
  });
});
