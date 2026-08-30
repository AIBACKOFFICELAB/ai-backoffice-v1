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
import { EstimateClosingLeadContext, EstimateFollowupSequenceContext } from "./types";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const NOW = new Date("2026-08-30T12:00:00Z");

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
    expect(result.newlyEmitted.length).toBe(1);

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
    expect(result.newlyEmitted.length).toBe(0);
    expect((await eventStore.listByTenant(TENANT_A)).length).toBe(0);
  });

  it("skips an ineligible candidate (already won) even if the timing would otherwise qualify", async () => {
    const reader = new InMemorySequenceWithLeadReader([candidate({ lead: { status: "Won" } })]);
    const eventStore = new InMemoryBusinessEventStore();

    const result = await scanForStalledEstimates({ reader, eventStore, now: NOW });
    expect(result.stalledFound).toBe(0);
  });

  it("suppresses a duplicate stalled event on a second scan of the same estimate", async () => {
    const reader = new InMemorySequenceWithLeadReader([candidate()]);
    const eventStore = new InMemoryBusinessEventStore();

    const first = await scanForStalledEstimates({ reader, eventStore, now: NOW });
    const second = await scanForStalledEstimates({ reader, eventStore, now: new Date(NOW.getTime() + 1000 * 60 * 60) });

    expect(first.newlyEmitted.length).toBe(1);
    // Second run still correctly reports the estimate as stalled...
    expect(second.stalledFound).toBe(1);
    // ...but does NOT treat it as a new emission — this is the guard against
    // "one estimate becoming stalled must not create uncontrolled model
    // calls" (only newlyEmitted entries ever trigger the shadow agent — see
    // runEstimateClosingShadowSweep).
    expect(second.newlyEmitted.length).toBe(0);

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
  it("triggers exactly one shadow reasoning run for one newly-stalled estimate, and none on the re-run", async () => {
    const reader = new InMemorySequenceWithLeadReader([candidate()]);
    const eventStore = new InMemoryBusinessEventStore();
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });

    await agentStore.create({
      tenantId: TENANT_A,
      agentType: "estimate_closing",
      name: "Estimate Closing Agent",
      status: "active",
      allowedTools: [],
      readScopes: [],
      writeScopes: [],
    });

    // MockChatProvider echoes the prompt rather than returning valid JSON,
    // so this run is expected to fail conservatively (invalid_response) —
    // what matters here is the COUNT of shadow invocations, not the
    // outcome shape (shadowRunner.test.ts already covers the valid-JSON
    // success path with a fixed-text provider).
    const first = await runEstimateClosingShadowSweep(
      { reader, eventStore, now: NOW },
      { agentStore, runStore, eventStore, gateway, isEnabled: () => true }
    );
    expect(first.shadowOutcomes.length).toBe(1);
    expect((await runStore.listByTenant(TENANT_A)).length).toBe(1);

    const second = await runEstimateClosingShadowSweep(
      { reader, eventStore, now: new Date(NOW.getTime() + 1000 * 60 * 60) },
      { agentStore, runStore, eventStore, gateway, isEnabled: () => true }
    );
    expect(second.shadowOutcomes.length).toBe(0);
    expect((await runStore.listByTenant(TENANT_A)).length).toBe(1); // unchanged
  });
});
