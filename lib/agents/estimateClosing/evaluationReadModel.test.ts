import { describe, it, expect } from "vitest";
import {
  parsePersistedReviewPayload,
  listEstimateClosingRecommendationReviews,
  pairRecommendationsWithReviews,
  confidenceBand,
  getEstimateClosingEvaluation,
  EstimateClosingRecommendationReviewView,
} from "./evaluationReadModel";
import { EstimateClosingRecommendationView } from "./recommendationReadModel";
import { InMemoryBusinessEventStore } from "@/lib/events/store";
import { InMemoryAgentRunStore } from "@/lib/agents/runStore";
import { ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID } from "./mode";

const VALID_RECOMMENDATION_PAYLOAD = {
  recommendation: "follow_up",
  confidence: 0.82,
  reasonCodes: ["no_response_since_sent"],
  suggestedChannel: "sms",
  suggestedTiming: "within_24_hours",
  opportunityValue: 4200,
  rationaleLength: 312,
  agentRunId: "run-1",
  sequenceId: "seq-1",
};

const VALID_REVIEW_PAYLOAD = {
  recommendationEventId: "rec-1",
  agentRunId: "run-1",
  verdict: "agree",
  wouldAct: "yes",
  reasonCodes: ["recommendation_correct"],
};

async function seedRecommendation(
  store: InMemoryBusinessEventStore,
  overrides: { tenantId?: string; entityId?: string | null; payload?: unknown; occurredAt?: string } = {}
) {
  const { event } = await store.insert({
    tenantId: overrides.tenantId ?? "tenant-1",
    eventType: "estimate.closing_recommendation_generated",
    actorType: "agent",
    entityType: "lead",
    entityId: overrides.entityId ?? "lead-1",
    payload: (overrides.payload ?? VALID_RECOMMENDATION_PAYLOAD) as Record<string, unknown>,
    occurredAt: overrides.occurredAt,
  });
  return event;
}

async function seedReview(
  store: InMemoryBusinessEventStore,
  overrides: { tenantId?: string; payload?: unknown; causationId?: string; occurredAt?: string } = {}
) {
  const payload = (overrides.payload ?? VALID_REVIEW_PAYLOAD) as Record<string, unknown>;
  // Mirrors review.ts's real production behavior: causationId is always
  // the recommendation event's own id — same value as
  // payload.recommendationEventId. Defaulting to it here (rather than
  // requiring every call site to pass both) keeps existing tests that
  // already set recommendationEventId correctly scoped without change.
  const causationId = overrides.causationId ?? (typeof payload.recommendationEventId === "string" ? payload.recommendationEventId : undefined);
  const { event } = await store.insert({
    tenantId: overrides.tenantId ?? "tenant-1",
    eventType: "estimate.closing_recommendation_reviewed",
    actorType: "user",
    entityType: "lead",
    entityId: "lead-1",
    causationId,
    payload,
    occurredAt: overrides.occurredAt,
  });
  return event;
}

function recView(overrides: Partial<EstimateClosingRecommendationView>): EstimateClosingRecommendationView {
  return {
    recommendationEventId: "rec-1",
    agentRunId: "run-1",
    leadId: "lead-1",
    sequenceId: "seq-1",
    occurredAt: "2026-09-01T00:00:00.000Z",
    recommendation: "follow_up",
    confidence: 0.8,
    reasonCodes: [],
    suggestedChannel: "sms",
    suggestedTiming: "within_24_hours",
    opportunityValue: 1000,
    mode: "shadow",
    ...overrides,
  };
}

function reviewView(overrides: Partial<EstimateClosingRecommendationReviewView>): EstimateClosingRecommendationReviewView {
  return {
    reviewEventId: "review-1",
    recommendationEventId: "rec-1",
    agentRunId: "run-1",
    verdict: "agree",
    wouldAct: "yes",
    reasonCodes: [],
    occurredAt: "2026-09-01T00:05:00.000Z",
    ...overrides,
  };
}

describe("parsePersistedReviewPayload", () => {
  it("parses a valid persisted review payload", () => {
    const result = parsePersistedReviewPayload(VALID_REVIEW_PAYLOAD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verdict).toBe("agree");
      expect(result.value.wouldAct).toBe("yes");
      expect(result.value.agentRunId).toBe("run-1");
    }
  });

  it("accepts a null agentRunId", () => {
    const result = parsePersistedReviewPayload({ ...VALID_REVIEW_PAYLOAD, agentRunId: null });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["not a record", "just a string"],
    ["missing recommendationEventId", { ...VALID_REVIEW_PAYLOAD, recommendationEventId: undefined }],
    ["non-string recommendationEventId", { ...VALID_REVIEW_PAYLOAD, recommendationEventId: 5 }],
    ["malformed verdict", { ...VALID_REVIEW_PAYLOAD, verdict: "strongly_agree" }],
    ["malformed wouldAct", { ...VALID_REVIEW_PAYLOAD, wouldAct: "maybe" }],
    ["non-array reasonCodes", { ...VALID_REVIEW_PAYLOAD, reasonCodes: "recommendation_correct" }],
    ["unknown reason code", { ...VALID_REVIEW_PAYLOAD, reasonCodes: ["made_up"] }],
    ["non-string agentRunId", { ...VALID_REVIEW_PAYLOAD, agentRunId: 5 }],
    ["null", null],
    ["array", []],
  ])("rejects: %s", (_label, payload) => {
    expect(parsePersistedReviewPayload(payload).ok).toBe(false);
  });
});

describe("listEstimateClosingRecommendationReviews", () => {
  it("reads valid review events scoped to the given recommendation ids", async () => {
    const store = new InMemoryBusinessEventStore();
    await seedReview(store, { payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: "rec-1" } });
    const result = await listEstimateClosingRecommendationReviews("tenant-1", ["rec-1"], { eventStore: store });
    expect(result.reviews).toHaveLength(1);
    expect(result.skippedMalformed).toBe(0);
    expect(result.reviews[0].verdict).toBe("agree");
  });

  it("excludes a review whose recommendation is not in the given id set", async () => {
    const store = new InMemoryBusinessEventStore();
    await seedReview(store, { payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: "rec-1" } });
    const result = await listEstimateClosingRecommendationReviews("tenant-1", ["rec-DIFFERENT"], { eventStore: store });
    expect(result.reviews).toHaveLength(0);
  });

  it("returns empty immediately for an empty id list", async () => {
    const store = new InMemoryBusinessEventStore();
    await seedReview(store, { payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: "rec-1" } });
    const result = await listEstimateClosingRecommendationReviews("tenant-1", [], { eventStore: store });
    expect(result).toEqual({ reviews: [], skippedMalformed: 0 });
  });

  it("skips a malformed review payload and counts it, never crashing", async () => {
    const store = new InMemoryBusinessEventStore();
    await seedReview(store, { payload: { verdict: "agree" }, causationId: "rec-1" }); // missing required fields
    const result = await listEstimateClosingRecommendationReviews("tenant-1", ["rec-1"], { eventStore: store });
    expect(result.reviews).toHaveLength(0);
    expect(result.skippedMalformed).toBe(1);
  });

  it("never reads across tenants", async () => {
    const store = new InMemoryBusinessEventStore();
    await seedReview(store, { tenantId: "tenant-A", payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: "rec-1" } });
    const result = await listEstimateClosingRecommendationReviews("tenant-B", ["rec-1"], { eventStore: store });
    expect(result.reviews).toHaveLength(0);
  });

  it("filters strictly on the review event type — a recommendation event is never mistaken for a review", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendation(store);
    const result = await listEstimateClosingRecommendationReviews("tenant-1", [rec.id], { eventStore: store });
    expect(result.reviews).toHaveLength(0);
  });

  it("fetches every in-scope review regardless of how many OTHER reviews exist elsewhere — the exact bug this fix closes (Codex review finding on PR #21)", async () => {
    const store = new InMemoryBusinessEventStore();
    // A large backlog of reviews for OLDER recommendations that would
    // previously have crowded a plain recency-bounded fetch (limit=200)
    // and pushed a newer, still-in-scope recommendation's own review out
    // of the window entirely.
    for (let i = 0; i < 250; i++) {
      await seedReview(store, { payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: `old-rec-${i}` } });
    }
    await seedReview(store, { payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: "rec-newer" } });

    const result = await listEstimateClosingRecommendationReviews("tenant-1", ["rec-newer"], { eventStore: store });
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0].recommendationEventId).toBe("rec-newer");
  });
});

describe("pairRecommendationsWithReviews", () => {
  it("pairs a recommendation with its matching review by recommendationEventId", () => {
    const rec = recView({ recommendationEventId: "rec-1" });
    const review = reviewView({ recommendationEventId: "rec-1" });
    const pairs = pairRecommendationsWithReviews([rec], [review]);
    expect(pairs).toEqual([{ recommendation: rec, review }]);
  });

  it("leaves review null for an unreviewed recommendation", () => {
    const rec = recView({ recommendationEventId: "rec-unreviewed" });
    const pairs = pairRecommendationsWithReviews([rec], []);
    expect(pairs).toEqual([{ recommendation: rec, review: null }]);
  });

  it("does not include a review whose recommendation isn't in the list", () => {
    const rec = recView({ recommendationEventId: "rec-1" });
    const orphanReview = reviewView({ recommendationEventId: "rec-does-not-exist" });
    const pairs = pairRecommendationsWithReviews([rec], [orphanReview]);
    expect(pairs).toEqual([{ recommendation: rec, review: null }]);
  });
});

describe("confidenceBand", () => {
  it("buckets low/medium/high correctly at the boundaries", () => {
    expect(confidenceBand(0)).toBe("low");
    expect(confidenceBand(0.49)).toBe("low");
    expect(confidenceBand(0.5)).toBe("medium");
    expect(confidenceBand(0.79)).toBe("medium");
    expect(confidenceBand(0.8)).toBe("high");
    expect(confidenceBand(1)).toBe("high");
  });
});

describe("getEstimateClosingEvaluation", () => {
  it("returns a truthful empty state with zero evidence — null rates, not fabricated percentages", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();
    const evaluation = await getEstimateClosingEvaluation("tenant-1", { eventStore, runStore });

    expect(evaluation.recommendationsGenerated).toBe(0);
    expect(evaluation.recommendationsReviewed).toBe(0);
    expect(evaluation.agreementRate).toBeNull();
    expect(evaluation.averageConfidence).toBeNull();
    expect(evaluation.opportunityValueAnalyzed).toBe(0);
    expect(evaluation.modelFailureCount).toBe(0);
    expect(evaluation.reviewedRecommendations).toEqual([]);
    expect(evaluation.recommendationsWithReviewStatus).toEqual([]);
    expect(evaluation.toolCallsAttributable).toBe(0);
    expect(evaluation.approvalsAttributable).toBe(0);
    expect(evaluation.customerActionsAttributable).toBe(0);
  });

  it("computes agreement math correctly against a mixed set of verdicts", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();

    const recs = await Promise.all([
      seedRecommendation(eventStore, { payload: { ...VALID_RECOMMENDATION_PAYLOAD } }),
      seedRecommendation(eventStore, { payload: { ...VALID_RECOMMENDATION_PAYLOAD } }),
      seedRecommendation(eventStore, { payload: { ...VALID_RECOMMENDATION_PAYLOAD } }),
      seedRecommendation(eventStore, { payload: { ...VALID_RECOMMENDATION_PAYLOAD } }), // unreviewed
    ]);

    await seedReview(eventStore, { payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: recs[0].id, verdict: "agree", wouldAct: "yes" } });
    await seedReview(eventStore, { payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: recs[1].id, verdict: "disagree", wouldAct: "no", reasonCodes: ["timing_wrong"] } });
    await seedReview(eventStore, { payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: recs[2].id, verdict: "unsure", wouldAct: "later" } });

    const evaluation = await getEstimateClosingEvaluation("tenant-1", { eventStore, runStore });

    expect(evaluation.recommendationsGenerated).toBe(4);
    expect(evaluation.recommendationsReviewed).toBe(3);
    expect(evaluation.agreeCount).toBe(1);
    expect(evaluation.disagreeCount).toBe(1);
    expect(evaluation.unsureCount).toBe(1);
    expect(evaluation.wouldActYes).toBe(1);
    expect(evaluation.wouldActNo).toBe(1);
    expect(evaluation.wouldActLater).toBe(1);
    expect(evaluation.agreementRate).toBeCloseTo(1 / 3);
    expect(evaluation.reviewReasonCodeBreakdown.timing_wrong).toBe(1);
    expect(evaluation.reviewedRecommendations).toHaveLength(3);
    expect(evaluation.recommendationsWithReviewStatus).toHaveLength(4);
    expect(evaluation.recommendationsWithReviewStatus.filter((p) => p.review === null)).toHaveLength(1);
  });

  it("never conflates opportunity value analyzed with recovered revenue — it is a plain sum, no attribution-confidence concept exists here", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();
    await seedRecommendation(eventStore, { payload: { ...VALID_RECOMMENDATION_PAYLOAD, opportunityValue: 1000 } });
    await seedRecommendation(eventStore, { payload: { ...VALID_RECOMMENDATION_PAYLOAD, opportunityValue: 2500 } });

    const evaluation = await getEstimateClosingEvaluation("tenant-1", { eventStore, runStore });
    expect(evaluation.opportunityValueAnalyzed).toBe(3500);
    // No field on this type is named/shaped like a revenue or outcome
    // figure — this is a structural assertion pinned by the type itself
    // (EstimateClosingEvaluation has no `revenue`/`outcome` field at all).
    expect("directRevenueRecoveredUsd" in evaluation).toBe(false);
  });

  it("computes confidence bands and reason-code breakdowns correctly", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();
    await seedRecommendation(eventStore, { payload: { ...VALID_RECOMMENDATION_PAYLOAD, confidence: 0.2, reasonCodes: ["low_value_estimate"] } });
    await seedRecommendation(eventStore, { payload: { ...VALID_RECOMMENDATION_PAYLOAD, confidence: 0.6, reasonCodes: ["repeat_customer"] } });
    await seedRecommendation(eventStore, { payload: { ...VALID_RECOMMENDATION_PAYLOAD, confidence: 0.95, reasonCodes: ["repeat_customer", "high_value_estimate"] } });

    const evaluation = await getEstimateClosingEvaluation("tenant-1", { eventStore, runStore });
    expect(evaluation.confidenceBandCounts).toEqual({ low: 1, medium: 1, high: 1 });
    expect(evaluation.reasonCodeBreakdown.repeat_customer).toBe(2);
    expect(evaluation.reasonCodeBreakdown.high_value_estimate).toBe(1);
    expect(evaluation.averageConfidence).toBeCloseTo((0.2 + 0.6 + 0.95) / 3);
  });

  it("counts model/run failures for the Estimate Closing shadow workflow only, within the bounded window", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();

    const failedShadowRun = await runStore.create({ tenantId: "tenant-1", agentId: "agent-1", workflowId: ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID });
    await runStore.update("tenant-1", failedShadowRun.id, { status: "failed", failureReason: "model gateway failed: timeout" });

    const succeededShadowRun = await runStore.create({ tenantId: "tenant-1", agentId: "agent-1", workflowId: ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID });
    await runStore.update("tenant-1", succeededShadowRun.id, { status: "succeeded" });

    const unrelatedFailedRun = await runStore.create({ tenantId: "tenant-1", agentId: "agent-2", workflowId: "some_other_workflow" });
    await runStore.update("tenant-1", unrelatedFailedRun.id, { status: "failed" });

    const evaluation = await getEstimateClosingEvaluation("tenant-1", { eventStore, runStore });
    expect(evaluation.modelFailureCount).toBe(1);
  });

  it("never reads across tenants for any evaluation input", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();

    const otherRec = await seedRecommendation(eventStore, { tenantId: "tenant-OTHER" });
    await seedReview(eventStore, { tenantId: "tenant-OTHER", payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: otherRec.id } });
    const run = await runStore.create({ tenantId: "tenant-OTHER", agentId: "agent-1", workflowId: ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID });
    await runStore.update("tenant-OTHER", run.id, { status: "failed" });

    const evaluation = await getEstimateClosingEvaluation("tenant-1", { eventStore, runStore });
    expect(evaluation.recommendationsGenerated).toBe(0);
    expect(evaluation.recommendationsReviewed).toBe(0);
    expect(evaluation.modelFailureCount).toBe(0);
  });

  it("skips malformed recommendation and review events safely, counting each", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();
    await seedRecommendation(eventStore, { payload: { recommendation: "not_a_real_value" }, entityId: "lead-malformed" });
    // The malformed review must reference a VALID recommendation to be
    // in-scope at all under the new causationId-scoped fetch — a review
    // for a recommendation that itself never parsed isn't reachable
    // either way, so this pins the real case: a valid recommendation with
    // a corrupted review.
    const validRec = await seedRecommendation(eventStore, { entityId: "lead-valid" });
    await seedReview(eventStore, { payload: { verdict: "agree" }, causationId: validRec.id });

    const evaluation = await getEstimateClosingEvaluation("tenant-1", { eventStore, runStore });
    expect(evaluation.recommendationsGenerated).toBe(1);
    expect(evaluation.skippedMalformedRecommendations).toBe(1);
    expect(evaluation.skippedMalformedReviews).toBe(1);
  });

  it("respects the bounded read limit across all inputs", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();
    for (let i = 0; i < 5; i++) {
      await seedRecommendation(eventStore, { entityId: `lead-${i}` });
    }
    const evaluation = await getEstimateClosingEvaluation("tenant-1", { eventStore, runStore, limit: 3 });
    expect(evaluation.recommendationsGenerated).toBe(3);
  });

  it("a recommendation's review is never lost behind a large backlog of reviews for older recommendations (Codex review finding on PR #21)", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();

    // A newer recommendation, reviewed once.
    const newerRec = await seedRecommendation(eventStore, { entityId: "lead-newer", occurredAt: "2026-09-01T12:00:00.000Z" });
    await seedReview(eventStore, { payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: newerRec.id, verdict: "agree" } });

    // A large backlog of reviews for unrelated OLDER recommendations —
    // before the fix, this alone was enough to push newerRec's review out
    // of a plain recency-bounded fetch even though newerRec itself
    // remains well within the recommendations window.
    for (let i = 0; i < 250; i++) {
      await seedReview(eventStore, { payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: `old-rec-${i}` } });
    }

    const evaluation = await getEstimateClosingEvaluation("tenant-1", { eventStore, runStore });

    expect(evaluation.recommendationsGenerated).toBe(1);
    expect(evaluation.recommendationsReviewed).toBe(1);
    expect(evaluation.agreeCount).toBe(1);
    expect(evaluation.agreementRate).toBe(1);
    const pair = evaluation.recommendationsWithReviewStatus[0];
    expect(pair.review).not.toBeNull();
    expect(pair.review?.recommendationEventId).toBe(newerRec.id);
  });
});

/**
 * RSC-safety regression suite (PR #19's permanent regression class — see
 * P1 Sprint 3 directive §16). getEstimateClosingEvaluation's return value
 * is passed from Server Components (app/(app)/agentic/estimate-closing/page.tsx,
 * app/(app)/dashboard/page.tsx) into Client Component props
 * (components/ai/RecommendationReviewCard.tsx -> ReviewControls.tsx) —
 * every field must be plain, JSON-round-trippable data. No function,
 * class instance, Map, Set, or Symbol may ever appear anywhere in this
 * shape.
 */
describe("RSC-safe: getEstimateClosingEvaluation output contains no function/component values", () => {
  function assertPlainSerializable(value: unknown, path = "root"): void {
    if (value === null || value === undefined) return;
    const t = typeof value;
    if (t === "function") throw new Error(`Non-serializable function value at ${path}`);
    if (t === "symbol" || t === "bigint") throw new Error(`Non-serializable ${t} value at ${path}`);
    if (t !== "object") return;
    if (value instanceof Date || value instanceof Map || value instanceof Set) {
      throw new Error(`Non-serializable ${value.constructor.name} instance at ${path}`);
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => assertPlainSerializable(v, `${path}[${i}]`));
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error(`Non-plain object (custom prototype) at ${path}`);
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) assertPlainSerializable(v, `${path}.${key}`);
  }

  it("a populated evaluation round-trips through JSON without loss and contains no non-serializable value", async () => {
    const eventStore = new InMemoryBusinessEventStore();
    const runStore = new InMemoryAgentRunStore();
    const rec = await seedRecommendation(eventStore);
    await seedReview(eventStore, { payload: { ...VALID_REVIEW_PAYLOAD, recommendationEventId: rec.id } });
    const failedRun = await runStore.create({ tenantId: "tenant-1", agentId: "agent-1", workflowId: ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID });
    await runStore.update("tenant-1", failedRun.id, { status: "failed" });

    const evaluation = await getEstimateClosingEvaluation("tenant-1", { eventStore, runStore });

    expect(() => assertPlainSerializable(evaluation)).not.toThrow();
    expect(JSON.parse(JSON.stringify(evaluation))).toEqual(evaluation);
  });

  it("the empty-evidence evaluation is also plain serializable", async () => {
    const evaluation = await getEstimateClosingEvaluation("tenant-1", { eventStore: new InMemoryBusinessEventStore(), runStore: new InMemoryAgentRunStore() });
    expect(() => assertPlainSerializable(evaluation)).not.toThrow();
  });
});
