import { describe, it, expect } from "vitest";
import {
  listEstimateClosingRecommendations,
  parsePersistedRecommendationPayload,
  summarizeEstimateClosingRecommendations,
  EstimateClosingRecommendationView,
} from "./recommendationReadModel";
import { InMemoryBusinessEventStore } from "@/lib/events/store";

const VALID_PAYLOAD = {
  recommendation: "follow_up",
  confidence: 0.82,
  reasonCodes: ["no_response_since_sent", "high_value_estimate"],
  suggestedChannel: "sms",
  suggestedTiming: "within_24_hours",
  opportunityValue: 4200,
  rationaleLength: 312,
  agentRunId: "run-1",
  sequenceId: "seq-1",
};

async function seedRecommendationEvent(
  store: InMemoryBusinessEventStore,
  overrides: { tenantId?: string; entityId?: string | null; payload?: unknown; occurredAt?: string } = {}
) {
  return store.insert({
    tenantId: overrides.tenantId ?? "tenant-1",
    eventType: "estimate.closing_recommendation_generated",
    actorType: "agent",
    entityType: "lead",
    entityId: overrides.entityId ?? "lead-1",
    payload: (overrides.payload ?? VALID_PAYLOAD) as Record<string, unknown>,
    occurredAt: overrides.occurredAt,
  });
}

describe("parsePersistedRecommendationPayload", () => {
  it("parses a valid persisted payload", () => {
    const result = parsePersistedRecommendationPayload(VALID_PAYLOAD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.recommendation).toBe("follow_up");
      expect(result.value.opportunityValue).toBe(4200);
      expect(result.value.agentRunId).toBe("run-1");
    }
  });

  it("accepts a payload with no agentRunId/sequenceId (both optional)", () => {
    const { agentRunId, sequenceId, ...rest } = VALID_PAYLOAD;
    const result = parsePersistedRecommendationPayload(rest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agentRunId).toBeNull();
      expect(result.value.sequenceId).toBeNull();
    }
  });

  it.each([
    ["not an object", "just a string"],
    ["null", null],
    ["an array", [1, 2, 3]],
    ["missing recommendation", { ...VALID_PAYLOAD, recommendation: undefined }],
    ["invalid recommendation enum", { ...VALID_PAYLOAD, recommendation: "close_the_deal" }],
    ["confidence out of range", { ...VALID_PAYLOAD, confidence: 1.5 }],
    ["confidence not a number", { ...VALID_PAYLOAD, confidence: "high" }],
    ["reasonCodes not an array", { ...VALID_PAYLOAD, reasonCodes: "no_response_since_sent" }],
    ["reasonCodes with unknown code", { ...VALID_PAYLOAD, reasonCodes: ["made_up_reason"] }],
    ["invalid suggestedChannel", { ...VALID_PAYLOAD, suggestedChannel: "carrier_pigeon" }],
    ["invalid suggestedTiming", { ...VALID_PAYLOAD, suggestedTiming: "eventually" }],
    ["opportunityValue not a number", { ...VALID_PAYLOAD, opportunityValue: "$4,200" }],
    ["agentRunId not a string", { ...VALID_PAYLOAD, agentRunId: 12345 }],
  ])("rejects malformed payload: %s", (_label, payload) => {
    const result = parsePersistedRecommendationPayload(payload);
    expect(result.ok).toBe(false);
  });

  it("never exposes a 'rationale' field — the type has no such field, by construction", () => {
    const result = parsePersistedRecommendationPayload({ ...VALID_PAYLOAD, rationale: "the model's raw prose" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // @ts-expect-error rationale does not exist on the parsed value's type
      expect(result.value.rationale).toBeUndefined();
    }
  });
});

describe("listEstimateClosingRecommendations", () => {
  it("parses a valid recommendation event into a typed view", async () => {
    const store = new InMemoryBusinessEventStore();
    await seedRecommendationEvent(store);

    const { recommendations, skippedMalformed } = await listEstimateClosingRecommendations("tenant-1", { eventStore: store });

    expect(skippedMalformed).toBe(0);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      leadId: "lead-1",
      recommendation: "follow_up",
      confidence: 0.82,
      opportunityValue: 4200,
      mode: "shadow",
    });
  });

  it("safely skips a malformed historical event instead of crashing or trusting it", async () => {
    const store = new InMemoryBusinessEventStore();
    await seedRecommendationEvent(store, { payload: { garbage: true } });
    await seedRecommendationEvent(store, { entityId: "lead-2" }); // one valid, for contrast

    const { recommendations, skippedMalformed } = await listEstimateClosingRecommendations("tenant-1", { eventStore: store });

    expect(skippedMalformed).toBe(1);
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].leadId).toBe("lead-2");
  });

  it("is tenant-isolated — never returns another tenant's recommendations", async () => {
    const store = new InMemoryBusinessEventStore();
    await seedRecommendationEvent(store, { tenantId: "tenant-a" });
    await seedRecommendationEvent(store, { tenantId: "tenant-b" });

    const forA = await listEstimateClosingRecommendations("tenant-a", { eventStore: store });
    expect(forA.recommendations).toHaveLength(1);

    const forC = await listEstimateClosingRecommendations("tenant-c", { eventStore: store });
    expect(forC.recommendations).toHaveLength(0);
  });

  it("bounds the read — never fetches more than the requested/default limit", async () => {
    const store = new InMemoryBusinessEventStore();
    for (let i = 0; i < 10; i++) {
      await seedRecommendationEvent(store, { entityId: `lead-${i}`, occurredAt: new Date(2026, 0, i + 1).toISOString() });
    }

    const { recommendations } = await listEstimateClosingRecommendations("tenant-1", { eventStore: store, limit: 3 });
    expect(recommendations).toHaveLength(3);
  });

  it("only reads estimate.closing_recommendation_generated events — never any other event type", async () => {
    const store = new InMemoryBusinessEventStore();
    await store.insert({ tenantId: "tenant-1", eventType: "estimate.stalled", entityId: "lead-1", payload: VALID_PAYLOAD });
    await seedRecommendationEvent(store);

    const { recommendations } = await listEstimateClosingRecommendations("tenant-1", { eventStore: store });
    expect(recommendations).toHaveLength(1);
  });

  it("opportunityValue on the view comes straight from the persisted field — never invented or recomputed here", async () => {
    const store = new InMemoryBusinessEventStore();
    await seedRecommendationEvent(store, { payload: { ...VALID_PAYLOAD, opportunityValue: 9999.5 } });

    const { recommendations } = await listEstimateClosingRecommendations("tenant-1", { eventStore: store });
    expect(recommendations[0].opportunityValue).toBe(9999.5);
  });

  it("the view type structurally has no field capable of carrying raw rationale text", async () => {
    const store = new InMemoryBusinessEventStore();
    await seedRecommendationEvent(store);
    const { recommendations } = await listEstimateClosingRecommendations("tenant-1", { eventStore: store });

    const keys = Object.keys(recommendations[0]);
    expect(keys).not.toContain("rationale");
    expect(keys.sort()).toEqual(
      [
        "recommendationEventId",
        "agentRunId",
        "leadId",
        "sequenceId",
        "occurredAt",
        "recommendation",
        "confidence",
        "reasonCodes",
        "suggestedChannel",
        "suggestedTiming",
        "opportunityValue",
        "mode",
      ].sort()
    );
  });
});

describe("summarizeEstimateClosingRecommendations", () => {
  const rec = (overrides: Partial<EstimateClosingRecommendationView>): EstimateClosingRecommendationView => ({
    recommendationEventId: "evt-1",
    agentRunId: "run-1",
    leadId: "lead-1",
    sequenceId: "seq-1",
    occurredAt: "2026-08-31T00:00:00.000Z",
    recommendation: "follow_up",
    confidence: 0.8,
    reasonCodes: [],
    suggestedChannel: "sms",
    suggestedTiming: "within_24_hours",
    opportunityValue: 1000,
    mode: "shadow",
    ...overrides,
  });

  it("returns all-zero, non-null-crashing values for an empty list", () => {
    const summary = summarizeEstimateClosingRecommendations([]);
    expect(summary).toEqual({
      estimatesAnalyzed: 0,
      opportunityValueAnalyzed: 0,
      followUpCount: 0,
      waitCount: 0,
      ownerReviewCount: 0,
      latestRecommendationAt: null,
    });
  });

  it("sums opportunity value and breaks down recommendation counts", () => {
    const summary = summarizeEstimateClosingRecommendations([
      rec({ recommendation: "follow_up", opportunityValue: 1000, occurredAt: "2026-08-01T00:00:00.000Z" }),
      rec({ recommendation: "wait", opportunityValue: 500, occurredAt: "2026-08-02T00:00:00.000Z" }),
      rec({ recommendation: "owner_review", opportunityValue: 2500, occurredAt: "2026-08-03T00:00:00.000Z" }),
      rec({ recommendation: "follow_up", opportunityValue: null, occurredAt: "2026-08-04T00:00:00.000Z" }),
    ]);

    expect(summary.estimatesAnalyzed).toBe(4);
    expect(summary.opportunityValueAnalyzed).toBe(4000); // null contributes 0, never NaN
    expect(summary.followUpCount).toBe(2);
    expect(summary.waitCount).toBe(1);
    expect(summary.ownerReviewCount).toBe(1);
    expect(summary.latestRecommendationAt).toBe("2026-08-04T00:00:00.000Z");
  });
});

/**
 * P1 Sprint 2 §12 — "treat [the PR #19 RSC hotfix] as a permanent
 * regression class." /agentic and /dashboard render this read model's
 * output through several Server Components; none of them are currently
 * "use client" (so nothing here crosses an actual Server -> Client props
 * boundary today), but the data these pages pass around must stay plain,
 * JSON-round-trippable data regardless — the same discipline
 * navConfig.test.ts enforces for the app shell, applied here so a future
 * refactor that DOES turn one of these into a client component inherits a
 * guarantee instead of a fresh footgun.
 */
describe("recommendation view/summary data stays RSC-safe (no functions, JSON round-trips cleanly)", () => {
  it("a recommendation view list round-trips through JSON without loss", async () => {
    const store = new InMemoryBusinessEventStore();
    await seedRecommendationEvent(store);
    await seedRecommendationEvent(store, { entityId: "lead-2", payload: { ...VALID_PAYLOAD, recommendation: "owner_review", agentRunId: null, sequenceId: null } });

    const { recommendations } = await listEstimateClosingRecommendations("tenant-1", { eventStore: store });
    const roundTripped = JSON.parse(JSON.stringify(recommendations));

    expect(roundTripped).toEqual(recommendations);
    for (const value of recommendations) {
      for (const v of Object.values(value)) {
        expect(typeof v).not.toBe("function");
      }
    }
  });

  it("a summary object round-trips through JSON without loss", () => {
    const summary = summarizeEstimateClosingRecommendations([
      {
        recommendationEventId: "evt-1",
        agentRunId: "run-1",
        leadId: "lead-1",
        sequenceId: "seq-1",
        occurredAt: "2026-08-01T00:00:00.000Z",
        recommendation: "follow_up",
        confidence: 0.5,
        reasonCodes: ["no_response_since_sent"],
        suggestedChannel: "sms",
        suggestedTiming: "within_24_hours",
        opportunityValue: 100,
        mode: "shadow",
      },
    ]);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    for (const v of Object.values(summary)) {
      expect(typeof v).not.toBe("function");
    }
  });
});
