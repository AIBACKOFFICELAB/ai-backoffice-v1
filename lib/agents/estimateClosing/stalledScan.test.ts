import { describe, it, expect } from "vitest";
import {
  scanForStalledEstimates,
  runEstimateClosingShadowSweep,
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
