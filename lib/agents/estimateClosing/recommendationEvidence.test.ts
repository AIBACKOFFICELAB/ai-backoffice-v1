import { describe, it, expect } from "vitest";
import { getEstimateClosingRecommendationEvidence } from "./recommendationEvidence";
import { InMemoryBusinessEventStore } from "@/lib/events/store";
import { InMemoryAgentRunStore } from "../runStore";
import { InMemoryModelInvocationStore } from "@/lib/ai/store";
import { FollowupSequenceRow } from "@/lib/modules/estimateFollowup/service";
import { PlumbingLead } from "@/data/leadModel";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

function noSequences() {
  return async (_tenantId: string): Promise<FollowupSequenceRow[]> => [];
}

function noLead() {
  return async (_id: string, _tenantId: string) => ({ lead: undefined, source: "mock-fallback" as const });
}

async function seedFullEvidence() {
  const eventStore = new InMemoryBusinessEventStore();
  const runStore = new InMemoryAgentRunStore();
  const modelInvocationStore = new InMemoryModelInvocationStore();

  const { event: stalledEvent } = await eventStore.insert({
    tenantId: TENANT_A,
    eventType: "estimate.stalled",
    entityType: "lead",
    entityId: "lead-1",
    idempotencyKey: "estimate.stalled:seq-1",
    payload: { sequenceId: "seq-1", estimateAmount: 3000, serviceType: "Drain Cleaning", daysSinceSent: 7 },
  });

  const run = await runStore.create({ tenantId: TENANT_A, agentId: "agent-1", triggerEventId: stalledEvent.id, workflowId: "estimate_closing_shadow" });
  await runStore.update(TENANT_A, run.id, { status: "succeeded", startedAt: "2026-09-01T09:00:00.000Z", completedAt: "2026-09-01T09:00:05.000Z", outputSummary: "sha256:abc;chars:250" });

  await modelInvocationStore.record({
    id: "inv-1", tenantId: TENANT_A, agentRunId: run.id, taskType: "generate", provider: "anthropic", model: "claude-sonnet-5",
    complexity: "medium", latencyPreference: null, costPreference: null, inputTokens: 200, outputTokens: 80, latencyMs: 1200,
    estimatedCostUsd: null, status: "succeeded", error: null, errorCategory: null,
  });

  const { event: recommendationEvent } = await eventStore.insert({
    tenantId: TENANT_A,
    eventType: "estimate.closing_recommendation_generated",
    actorType: "agent",
    entityType: "lead",
    entityId: "lead-1",
    causationId: stalledEvent.id,
    payload: {
      recommendation: "follow_up",
      confidence: 0.75,
      reasonCodes: ["no_response_since_sent"],
      suggestedChannel: "sms",
      suggestedTiming: "within_24_hours",
      opportunityValue: 3000,
      agentRunId: run.id,
      sequenceId: "seq-1",
    },
  });

  const sequences: FollowupSequenceRow[] = [
    { id: "seq-1", leadId: "lead-1", status: "completed", estimateSentAt: "2026-08-15T09:00:00Z", day1DueAt: "2026-08-16T09:00:00Z", day3DueAt: "2026-08-18T09:00:00Z", day7DueAt: "2026-08-22T09:00:00Z", day1SentAt: null, day3SentAt: null, day7SentAt: null, lastReplyAt: null, stoppedReason: null },
  ];
  const lead: PlumbingLead = {
    id: "lead-1", date: "2026-08-01", customerName: "Jane Doe", phone: "+15550001111", email: "", serviceAddress: "123 Main St",
    propertyType: "Single Family Home", serviceType: "Drain Cleaning", emergency: "No", urgency: "Flexible", jobDescription: "",
    photosUploaded: "No", preferredAppointmentTime: "", customerRole: "Owner", leadSource: "Website", customerNotes: "",
    status: "Estimate Sent", estimateAmount: 3000, followUpDate: "", reviewRequestStatus: "Not Ready", internalNotes: "",
    createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z", smsSentAt: null,
  };

  return {
    eventStore, runStore, modelInvocationStore,
    recommendationEventId: recommendationEvent.id,
    getSequencesForTenant: async (_tenantId: string) => sequences,
    getLead: async (_id: string, _tenantId: string) => ({ lead, source: "supabase" as const }),
  };
}

describe("getEstimateClosingRecommendationEvidence", () => {
  it("resolves the full evidence chain for a same-tenant recommendation", async () => {
    const seeded = await seedFullEvidence();
    const evidence = await getEstimateClosingRecommendationEvidence(
      { tenantId: TENANT_A, recommendationEventId: seeded.recommendationEventId },
      seeded
    );

    expect(evidence.found).toBe(true);
    if (!evidence.found) throw new Error("expected found");
    expect(evidence.recommendation.recommendation).toBe("follow_up");
    expect(evidence.stalledEventFound).toBe(true);
    expect(evidence.stalledEventOccurredAt).toBeTruthy();
    expect(evidence.agentRun?.status).toBe("succeeded");
    expect(evidence.agentRun?.outputFingerprint).toBe("sha256:abc;chars:250");
    expect(evidence.modelInvocation).toEqual({ provider: "anthropic", model: "claude-sonnet-5", status: "succeeded", errorCategory: null, latencyMs: 1200, inputTokens: 200, outputTokens: 80 });
    expect(evidence.sequence?.status).toBe("completed");
    expect(evidence.leadStatus).toBe("Estimate Sent");
    expect(evidence.review).toBeNull();
    expect(evidence.followThrough).toBeNull();
    expect(evidence.followThroughOccurredAt).toBeNull();
    expect(evidence.attributionState).toEqual({ evidenceStage: "RECOMMENDATION_RECORDED", attributionStage: "ATTRIBUTION_NOT_ESTABLISHED" });
    expect(evidence.toolCallExists).toBe(false);
    expect(evidence.approvalExists).toBe(false);
    expect(evidence.customerActionExists).toBe(false);
  });

  it("the owner's follow-through, when recorded, is correctly attached and advances the attribution evidence stage", async () => {
    const seeded = await seedFullEvidence();
    await seeded.eventStore.insert({
      tenantId: TENANT_A,
      eventType: "estimate.closing_recommendation_followthrough_recorded",
      actorType: "user",
      causationId: seeded.recommendationEventId,
      idempotencyKey: "followthrough-key-1",
      payload: { recommendationEventId: seeded.recommendationEventId, actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" },
    });

    const evidence = await getEstimateClosingRecommendationEvidence({ tenantId: TENANT_A, recommendationEventId: seeded.recommendationEventId }, seeded);
    expect(evidence.found).toBe(true);
    if (!evidence.found) throw new Error("expected found");
    expect(evidence.followThrough).toEqual({
      recommendationEventId: seeded.recommendationEventId,
      actionTaken: "yes",
      actionChannel: "phone",
      customerResponse: "observed",
      businessDisposition: "won",
    });
    expect(evidence.followThroughOccurredAt).toBeTruthy();
    // No review was recorded in this scenario, but the follow-through
    // itself carries action=yes + response=observed + disposition=won, so
    // the ladder reaches its furthest evidence rung purely from
    // follow-through — review and follow-through are independent evidence
    // types, neither gates the other.
    expect(evidence.attributionState.evidenceStage).toBe("BUSINESS_DISPOSITION_OBSERVED");
    expect(evidence.attributionState.attributionStage).toBe("ATTRIBUTION_NOT_ESTABLISHED");
  });

  it("a follow-through CORRECTION (a later, different submission) is what the evidence packet reflects as current — the append-only history is never lost, but only the latest is surfaced", async () => {
    const seeded = await seedFullEvidence();
    await seeded.eventStore.insert({
      tenantId: TENANT_A,
      eventType: "estimate.closing_recommendation_followthrough_recorded",
      actorType: "user",
      causationId: seeded.recommendationEventId,
      idempotencyKey: "followthrough-key-1",
      occurredAt: "2026-09-02T00:00:00.000Z",
      payload: { recommendationEventId: seeded.recommendationEventId, actionTaken: "later", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" },
    });
    await seeded.eventStore.insert({
      tenantId: TENANT_A,
      eventType: "estimate.closing_recommendation_followthrough_recorded",
      actorType: "user",
      causationId: seeded.recommendationEventId,
      idempotencyKey: "followthrough-key-2",
      occurredAt: "2026-09-05T00:00:00.000Z",
      payload: { recommendationEventId: seeded.recommendationEventId, actionTaken: "yes", actionChannel: "sms", customerResponse: "observed", businessDisposition: "won" },
    });

    const evidence = await getEstimateClosingRecommendationEvidence({ tenantId: TENANT_A, recommendationEventId: seeded.recommendationEventId }, seeded);
    expect(evidence.found).toBe(true);
    if (!evidence.found) throw new Error("expected found");
    expect(evidence.followThrough?.actionTaken).toBe("yes");
    expect(evidence.followThrough?.businessDisposition).toBe("won");
  });

  it("a cross-tenant recommendation is completely inaccessible — never distinguishable from 'doesn't exist'", async () => {
    const seeded = await seedFullEvidence();
    const evidence = await getEstimateClosingRecommendationEvidence(
      { tenantId: TENANT_B, recommendationEventId: seeded.recommendationEventId },
      seeded
    );
    expect(evidence).toEqual({ found: false });
  });

  it("an unknown recommendation id returns the identical { found: false } shape", async () => {
    const seeded = await seedFullEvidence();
    const evidence = await getEstimateClosingRecommendationEvidence(
      { tenantId: TENANT_A, recommendationEventId: "does-not-exist" },
      seeded
    );
    expect(evidence).toEqual({ found: false });
  });

  it("a missing stalled event (causationId points nowhere) is handled safely — stalledEventFound is false, never a crash or a fabricated relation", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const { event: recommendationEvent } = await eventStore.insert({
      tenantId: TENANT_A,
      eventType: "estimate.closing_recommendation_generated",
      entityType: "lead",
      entityId: "lead-1",
      causationId: "nonexistent-stalled-event",
      payload: { recommendation: "wait", confidence: 0.4, reasonCodes: [], suggestedChannel: "none", suggestedTiming: null, opportunityValue: 1000, agentRunId: null, sequenceId: null },
    });

    const evidence = await getEstimateClosingRecommendationEvidence(
      { tenantId: TENANT_A, recommendationEventId: recommendationEvent.id },
      { eventStore, runStore: new InMemoryAgentRunStore(), modelInvocationStore: new InMemoryModelInvocationStore(), getSequencesForTenant: noSequences(), getLead: noLead() }
    );

    expect(evidence.found).toBe(true);
    if (!evidence.found) throw new Error("expected found");
    expect(evidence.stalledEventFound).toBe(false);
    expect(evidence.stalledEventOccurredAt).toBeNull();
    expect(evidence.agentRun).toBeNull();
  });

  it("a missing model invocation for an existing agent run is handled safely — modelInvocation is null, never fabricated", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();
    const run = await runStore.create({ tenantId: TENANT_A, agentId: "agent-1", workflowId: "estimate_closing_shadow" });
    await runStore.update(TENANT_A, run.id, { status: "succeeded" });

    const { event: recommendationEvent } = await eventStore.insert({
      tenantId: TENANT_A,
      eventType: "estimate.closing_recommendation_generated",
      entityType: "lead",
      entityId: "lead-1",
      payload: { recommendation: "wait", confidence: 0.4, reasonCodes: [], suggestedChannel: "none", suggestedTiming: null, opportunityValue: 1000, agentRunId: run.id, sequenceId: null },
    });

    const evidence = await getEstimateClosingRecommendationEvidence(
      { tenantId: TENANT_A, recommendationEventId: recommendationEvent.id },
      { eventStore, runStore, modelInvocationStore: new InMemoryModelInvocationStore() /* empty — no invocation recorded */, getSequencesForTenant: noSequences(), getLead: noLead() }
    );

    expect(evidence.found).toBe(true);
    if (!evidence.found) throw new Error("expected found");
    expect(evidence.agentRun).not.toBeNull();
    expect(evidence.modelInvocation).toBeNull();
  });

  it("never exposes a raw model prompt or response — the evidence shape has no field for either", async () => {
    const seeded = await seedFullEvidence();
    const evidence = await getEstimateClosingRecommendationEvidence(
      { tenantId: TENANT_A, recommendationEventId: seeded.recommendationEventId },
      seeded
    );
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toMatch(/prompt|rawResponse|rationale/i);
  });

  it("the owner's review, when one exists, is correctly attached", async () => {
    const seeded = await seedFullEvidence();
    await seeded.eventStore.insert({
      tenantId: TENANT_A,
      eventType: "estimate.closing_recommendation_reviewed",
      actorType: "user",
      causationId: seeded.recommendationEventId,
      idempotencyKey: `estimate.closing_recommendation_reviewed:${seeded.recommendationEventId}`,
      payload: { recommendationEventId: seeded.recommendationEventId, agentRunId: null, verdict: "agree", wouldAct: "yes", reasonCodes: ["recommendation_correct"] },
    });

    const evidence = await getEstimateClosingRecommendationEvidence(
      { tenantId: TENANT_A, recommendationEventId: seeded.recommendationEventId },
      seeded
    );
    expect(evidence.found).toBe(true);
    if (!evidence.found) throw new Error("expected found");
    expect(evidence.review?.verdict).toBe("agree");
    expect(evidence.review?.wouldAct).toBe("yes");
  });

  it("an unreviewed recommendation correctly reports review: null, not a fabricated default", async () => {
    const seeded = await seedFullEvidence();
    const evidence = await getEstimateClosingRecommendationEvidence(
      { tenantId: TENANT_A, recommendationEventId: seeded.recommendationEventId },
      seeded
    );
    expect(evidence.found).toBe(true);
    if (!evidence.found) throw new Error("expected found");
    expect(evidence.review).toBeNull();
  });

  it("a follow-through record belonging to a DIFFERENT recommendation never leaks into this one's evidence (causationId scoping)", async () => {
    const seeded = await seedFullEvidence();
    const { event: otherRec } = await seeded.eventStore.insert({
      tenantId: TENANT_A,
      eventType: "estimate.closing_recommendation_generated",
      entityType: "lead",
      entityId: "lead-2",
      payload: { recommendation: "wait", confidence: 0.4, reasonCodes: [], suggestedChannel: "none", suggestedTiming: null, opportunityValue: 500, agentRunId: null, sequenceId: null },
    });
    await seeded.eventStore.insert({
      tenantId: TENANT_A,
      eventType: "estimate.closing_recommendation_followthrough_recorded",
      actorType: "user",
      causationId: otherRec.id,
      payload: { recommendationEventId: otherRec.id, actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" },
    });

    const evidence = await getEstimateClosingRecommendationEvidence({ tenantId: TENANT_A, recommendationEventId: seeded.recommendationEventId }, seeded);
    expect(evidence.found).toBe(true);
    if (!evidence.found) throw new Error("expected found");
    expect(evidence.followThrough).toBeNull();
  });

  it("never infers an outcome — the evidence shape carries no outcome/revenue field at all", async () => {
    const seeded = await seedFullEvidence();
    const evidence = await getEstimateClosingRecommendationEvidence(
      { tenantId: TENANT_A, recommendationEventId: seeded.recommendationEventId },
      seeded
    );
    expect(evidence.found).toBe(true);
    if (!evidence.found) throw new Error("expected found");
    expect(Object.keys(evidence)).not.toContain("outcome");
    expect(Object.keys(evidence)).not.toContain("revenueRecovered");
  });

  it("a malformed persisted recommendation payload is refused, never used to build a fabricated evidence chain", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const { event } = await eventStore.insert({
      tenantId: TENANT_A,
      eventType: "estimate.closing_recommendation_generated",
      entityType: "lead",
      entityId: "lead-1",
      payload: { recommendation: "not-a-real-value" },
    });

    const evidence = await getEstimateClosingRecommendationEvidence(
      { tenantId: TENANT_A, recommendationEventId: event.id },
      { eventStore, runStore: new InMemoryAgentRunStore(), modelInvocationStore: new InMemoryModelInvocationStore(), getSequencesForTenant: noSequences(), getLead: noLead() }
    );
    expect(evidence).toEqual({ found: false });
  });
});
