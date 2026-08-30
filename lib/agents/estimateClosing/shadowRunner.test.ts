import { describe, it, expect, vi } from "vitest";
import { triggerEstimateClosingShadow } from "./shadowRunner";
import { InMemoryAgentStore } from "../agentStore";
import { InMemoryAgentRunStore } from "../runStore";
import { InMemoryBusinessEventStore } from "@/lib/events/store";
import { AiGateway } from "@/lib/ai/gateway";
import { InMemoryModelInvocationStore } from "@/lib/ai/store";
import { InMemoryOutcomeStore } from "@/lib/outcomes/store";
import { ChatProvider, ChatCompleteParams, ChatCompleteResult } from "@/lib/ai/providers/types";
import { EstimateClosingLeadContext, EstimateFollowupSequenceContext } from "./types";

const TENANT = "tenant-1";

function makeLead(overrides: Partial<EstimateClosingLeadContext> = {}): EstimateClosingLeadContext {
  return {
    id: "lead-1",
    tenantId: TENANT,
    status: "Estimate Sent",
    estimateAmount: 4200,
    serviceType: "Water Heater",
    leadSource: "Google",
    urgency: "This Week",
    ...overrides,
  };
}

function makeSequence(overrides: Partial<EstimateFollowupSequenceContext> = {}): EstimateFollowupSequenceContext {
  return {
    id: "seq-1",
    tenantId: TENANT,
    leadId: "lead-1",
    status: "completed",
    estimateSentAt: "2026-08-01T09:00:00Z",
    day7DueAt: "2026-08-08T09:00:00Z",
    lastReplyAt: null,
    ...overrides,
  };
}

/** Returns whatever fixed text is given, ignoring the prompt entirely —
 * gives full control over generateStructured's validation branch. */
class FixedTextProvider implements ChatProvider {
  id = "mock";
  constructor(private readonly text: string | (() => string)) {}
  async complete(_params: ChatCompleteParams): Promise<ChatCompleteResult> {
    const text = typeof this.text === "function" ? this.text() : this.text;
    return { text, inputTokens: 10, outputTokens: 10 };
  }
}

class ThrowingProvider implements ChatProvider {
  id = "mock";
  async complete(): Promise<ChatCompleteResult> {
    throw Object.assign(new Error("boom"), { status: 500 });
  }
}

const VALID_RESPONSE = JSON.stringify({
  recommendation: "follow_up",
  confidence: 0.8,
  reasonCodes: ["no_response_since_sent", "automated_sequence_exhausted"],
  rationale: "The customer has not replied and the automated sequence has completed.",
  suggestedChannel: "phone",
  suggestedTiming: "within_24_hours",
});

async function seedActiveAgent(agentStore: InMemoryAgentStore) {
  return agentStore.create({
    tenantId: TENANT,
    agentType: "estimate_closing",
    name: "Estimate Closing Agent",
    status: "active",
    allowedTools: [],
    readScopes: [],
    writeScopes: [],
  });
}

function makeHarness(providerText: string | (() => string) = VALID_RESPONSE) {
  const agentStore = new InMemoryAgentStore();
  const runStore = new InMemoryAgentRunStore();
  const eventStore = new InMemoryBusinessEventStore();
  const outcomeStore = new InMemoryOutcomeStore();
  const gateway = new AiGateway({
    chatProviders: { mock: new FixedTextProvider(providerText) },
    invocationStore: new InMemoryModelInvocationStore(),
  });
  return { agentStore, runStore, eventStore, outcomeStore, gateway };
}

describe("triggerEstimateClosingShadow — shadow mode safety", () => {
  it("does nothing when the production feature flag is disabled", async () => {
    const { agentStore, runStore, eventStore, gateway } = makeHarness();
    await seedActiveAgent(agentStore);

    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-1", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => false,
    });

    expect(outcome).toEqual({ status: "skipped", reason: "feature_disabled" });
    expect((await runStore.listByTenant(TENANT)).length).toBe(0);
    expect((await eventStore.listByTenant(TENANT)).length).toBe(0);
  });

  it("does nothing when no estimate_closing agent row exists for the tenant", async () => {
    const { agentStore, runStore, eventStore, gateway } = makeHarness();
    // No agent seeded.
    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-1", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "agent_missing" });
    expect((await runStore.listByTenant(TENANT)).length).toBe(0);
  });

  it("does nothing when the agent row exists but is not active", async () => {
    const { agentStore, runStore, eventStore, gateway } = makeHarness();
    await agentStore.create({
      tenantId: TENANT,
      agentType: "estimate_closing",
      name: "Estimate Closing Agent",
      status: "inactive",
      allowedTools: [],
      readScopes: [],
      writeScopes: [],
    });

    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-1", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "agent_inactive" });
    expect((await runStore.listByTenant(TENANT)).length).toBe(0);
  });

  it("does nothing when a run triggered by this exact event has already succeeded (retry-safety gate — Codex P1 finding)", async () => {
    const { agentStore, runStore, eventStore, gateway } = makeHarness();
    const agent = await seedActiveAgent(agentStore);
    // Simulate a prior successful run for this exact trigger event, without
    // going through the full pipeline — proves the gate itself, independent
    // of how the prior success was produced.
    const priorRun = await runStore.create({ tenantId: TENANT, agentId: agent.id, triggerEventId: "evt-already-done" });
    await runStore.update(TENANT, priorRun.id, { status: "succeeded" });

    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-already-done", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });

    expect(outcome).toEqual({ status: "skipped", reason: "already_processed" });
    // No second run was created for this trigger event.
    const runsForEvent = (await runStore.listByTenant(TENANT)).filter((r) => r.triggerEventId === "evt-already-done");
    expect(runsForEvent.length).toBe(1);
  });

  it("does NOT skip when a prior run for this event failed (only a succeeded run blocks a retry)", async () => {
    const { agentStore, runStore, eventStore, gateway } = makeHarness();
    const agent = await seedActiveAgent(agentStore);
    const priorRun = await runStore.create({ tenantId: TENANT, agentId: agent.id, triggerEventId: "evt-failed-before" });
    await runStore.update(TENANT, priorRun.id, { status: "failed", failureReason: "model gateway failed: timeout" });

    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-failed-before", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });

    expect(outcome.status).toBe("succeeded"); // the retry itself succeeds (VALID_RESPONSE provider)
  });

  it("does nothing when the estimate is not actually eligible (e.g. already won)", async () => {
    const { agentStore, runStore, eventStore, gateway } = makeHarness();
    await seedActiveAgent(agentStore);

    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-1", makeLead({ status: "Won" }), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "not_eligible" });
    expect((await runStore.listByTenant(TENANT)).length).toBe(0);
  });

  it("produces exactly one agent run and one recommendation event for one eligible trigger", async () => {
    const { agentStore, runStore, eventStore, gateway } = makeHarness();
    const agent = await seedActiveAgent(agentStore);

    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-stalled-1", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });

    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") throw new Error("unreachable");

    const runs = await runStore.listByTenant(TENANT);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].agentId).toBe(agent.id);
    expect(runs[0].triggerEventId).toBe("evt-stalled-1");

    const events = await eventStore.listByTenant(TENANT, { eventType: "estimate.closing_recommendation_generated" });
    expect(events.length).toBe(1);
    expect(events[0].causationId).toBe("evt-stalled-1");
    expect(events[0].entityType).toBe("lead");
    expect(events[0].entityId).toBe("lead-1");

    expect(outcome.recommendation.recommendation).toBe("follow_up");
    expect(outcome.recommendation.opportunityValue).toBe(4200); // deterministic, from the lead's own amount
  });

  it("computes opportunityValue deterministically from the lead's stored amount, never from the model", async () => {
    // The model's JSON response contains no opportunityValue field at all —
    // validateEstimateClosingModelOutput doesn't even accept one — proving
    // the number in the final recommendation can only have come from the
    // lead record.
    const { agentStore, runStore, eventStore, gateway } = makeHarness();
    await seedActiveAgent(agentStore);

    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-1", makeLead({ estimateAmount: 9999.5 }), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") throw new Error("unreachable");
    expect(outcome.recommendation.opportunityValue).toBe(9999.5);
  });

  it("fails safely when the model gateway throws — no event, truthful failure recorded", async () => {
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const eventStore = new InMemoryBusinessEventStore();
    const gateway = new AiGateway({ chatProviders: { mock: new ThrowingProvider() }, invocationStore: new InMemoryModelInvocationStore() });
    await seedActiveAgent(agentStore);

    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-1", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });

    expect(outcome.status).toBe("failed");
    const runs = await runStore.listByTenant(TENANT);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].failureReason).toBeTruthy();
    expect((await eventStore.listByTenant(TENANT)).length).toBe(0);
  });

  it("fails conservatively on a malformed/invalid model response — no fabricated recommendation, no event", async () => {
    const { agentStore, runStore, eventStore, gateway } = makeHarness("this is not JSON at all");
    await seedActiveAgent(agentStore);

    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-1", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });

    expect(outcome.status).toBe("failed");
    const runs = await runStore.listByTenant(TENANT);
    expect(runs[0].status).toBe("failed");
    expect((await eventStore.listByTenant(TENANT)).length).toBe(0);
  });

  it("fails conservatively on a well-formed JSON response with an out-of-set reason code", async () => {
    const badResponse = JSON.stringify({
      recommendation: "follow_up",
      confidence: 0.5,
      reasonCodes: ["made_up_reason"],
      rationale: "Some rationale text.",
      suggestedChannel: "sms",
      suggestedTiming: null,
    });
    const { agentStore, runStore, eventStore, gateway } = makeHarness(badResponse);
    await seedActiveAgent(agentStore);

    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-1", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });
    expect(outcome.status).toBe("failed");
    expect((await eventStore.listByTenant(TENANT)).length).toBe(0);
  });

  it("never persists the raw rationale text — only a fingerprint — in agent_runs.output_summary", async () => {
    const { agentStore, runStore, eventStore, gateway } = makeHarness();
    await seedActiveAgent(agentStore);

    await triggerEstimateClosingShadow(TENANT, "evt-1", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });

    const runs = await runStore.listByTenant(TENANT);
    expect(runs[0].outputSummary).toBeTruthy();
    expect(runs[0].outputSummary).not.toContain("The customer has not replied");
    expect(runs[0].outputSummary).toMatch(/^sha256:[0-9a-f]+;chars:\d+$/);
  });

  it("never persists raw customer PII or the raw rationale in the recommendation event payload", async () => {
    const { agentStore, runStore, eventStore, gateway } = makeHarness();
    await seedActiveAgent(agentStore);

    await triggerEstimateClosingShadow(TENANT, "evt-1", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });

    const events = await eventStore.listByTenant(TENANT, { eventType: "estimate.closing_recommendation_generated" });
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.rationale).toBeUndefined();
    expect(payload.customerName).toBeUndefined();
    expect(payload.phone).toBeUndefined();
    expect(payload.email).toBeUndefined();
    expect(typeof payload.rationaleLength).toBe("number");
  });

  it("never records a business outcome — a shadow recommendation is not a realized result", async () => {
    const { agentStore, runStore, eventStore, gateway, outcomeStore } = makeHarness();
    await seedActiveAgent(agentStore);

    const outcome = await triggerEstimateClosingShadow(TENANT, "evt-1", makeLead(), makeSequence(), {
      agentStore,
      runStore,
      eventStore,
      gateway,
      isEnabled: () => true,
    });

    expect(outcome.status).toBe("succeeded");
    expect((await outcomeStore.listByTenant(TENANT)).length).toBe(0);
  });
});
