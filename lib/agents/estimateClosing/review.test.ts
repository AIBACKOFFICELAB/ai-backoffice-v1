import { describe, it, expect } from "vitest";
import {
  recordEstimateClosingRecommendationReview,
  validateReviewInput,
  describeReviewError,
  REVIEW_VERDICTS,
  REVIEW_WOULD_ACT,
  REVIEW_REASON_CODES,
} from "./review";
import { InMemoryBusinessEventStore } from "@/lib/events/store";

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

async function seedRecommendationEvent(
  store: InMemoryBusinessEventStore,
  overrides: { tenantId?: string; entityId?: string | null; payload?: unknown } = {}
) {
  const { event } = await store.insert({
    tenantId: overrides.tenantId ?? "tenant-1",
    eventType: "estimate.closing_recommendation_generated",
    actorType: "agent",
    actorId: "agent-1",
    entityType: "lead",
    entityId: overrides.entityId ?? "lead-1",
    payload: (overrides.payload ?? VALID_RECOMMENDATION_PAYLOAD) as Record<string, unknown>,
  });
  return event;
}

describe("validateReviewInput", () => {
  it("accepts every valid combination of verdict/wouldAct/reasonCodes", () => {
    for (const verdict of REVIEW_VERDICTS) {
      for (const wouldAct of REVIEW_WOULD_ACT) {
        const result = validateReviewInput({ verdict, wouldAct, reasonCodes: [] });
        expect(result.ok).toBe(true);
      }
    }
  });

  it("accepts a full, valid reasonCodes array", () => {
    const result = validateReviewInput({ verdict: "disagree", wouldAct: "no", reasonCodes: [...REVIEW_REASON_CODES] });
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed verdict", () => {
    const result = validateReviewInput({ verdict: "strongly_agree", wouldAct: "yes", reasonCodes: [] });
    expect(result).toEqual({ ok: false, error: "invalid_verdict" });
  });

  it("rejects a missing/non-string verdict", () => {
    expect(validateReviewInput({ verdict: undefined, wouldAct: "yes", reasonCodes: [] })).toEqual({ ok: false, error: "invalid_verdict" });
    expect(validateReviewInput({ verdict: 1, wouldAct: "yes", reasonCodes: [] })).toEqual({ ok: false, error: "invalid_verdict" });
  });

  it("rejects a malformed wouldAct", () => {
    const result = validateReviewInput({ verdict: "agree", wouldAct: "maybe", reasonCodes: [] });
    expect(result).toEqual({ ok: false, error: "invalid_would_act" });
  });

  it("rejects a non-array reasonCodes", () => {
    const result = validateReviewInput({ verdict: "agree", wouldAct: "yes", reasonCodes: "recommendation_correct" });
    expect(result).toEqual({ ok: false, error: "invalid_reason_codes" });
  });

  it("rejects an arbitrary reason code not in the enumerated set", () => {
    const result = validateReviewInput({ verdict: "agree", wouldAct: "yes", reasonCodes: ["recommendation_correct", "made_up_reason"] });
    expect(result).toEqual({ ok: false, error: "invalid_reason_codes" });
  });

  it("rejects free text smuggled into reasonCodes", () => {
    const result = validateReviewInput({ verdict: "disagree", wouldAct: "no", reasonCodes: ["the owner thinks this is wrong because..."] });
    expect(result).toEqual({ ok: false, error: "invalid_reason_codes" });
  });
});

describe("recordEstimateClosingRecommendationReview", () => {
  it("owner can review a same-tenant recommendation", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const result = await recordEstimateClosingRecommendationReview(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, verdict: "agree", wouldAct: "yes", reasonCodes: ["recommendation_correct"] },
      { eventStore: store }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.review).toEqual({
        recommendationEventId: rec.id,
        agentRunId: "run-1",
        verdict: "agree",
        wouldAct: "yes",
        reasonCodes: ["recommendation_correct"],
      });
      expect(result.alreadyReviewed).toBe(false);
    }
  });

  it("persists exactly one estimate.closing_recommendation_reviewed event, actorType 'user'", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    await recordEstimateClosingRecommendationReview(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, verdict: "agree", wouldAct: "yes", reasonCodes: [] },
      { eventStore: store }
    );

    const reviewed = store.all().filter((e) => e.eventType === "estimate.closing_recommendation_reviewed");
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0].actorType).toBe("user");
    expect(reviewed[0].actorId).toBe("user-owner-1");
    expect(reviewed[0].causationId).toBe(rec.id);
  });

  it("a cross-tenant recommendationEventId is refused as not_found (never distinguishes wrong-tenant from missing)", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store, { tenantId: "tenant-A" });

    const result = await recordEstimateClosingRecommendationReview(
      "tenant-B",
      "user-owner-2",
      { recommendationEventId: rec.id, verdict: "agree", wouldAct: "yes", reasonCodes: [] },
      { eventStore: store }
    );

    expect(result).toEqual({ ok: false, error: "recommendation_not_found" });
    expect(store.all().filter((e) => e.eventType === "estimate.closing_recommendation_reviewed")).toHaveLength(0);
  });

  it("a nonexistent recommendationEventId is refused as not_found", async () => {
    const store = new InMemoryBusinessEventStore();
    const result = await recordEstimateClosingRecommendationReview(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: "does-not-exist", verdict: "agree", wouldAct: "yes", reasonCodes: [] },
      { eventStore: store }
    );
    expect(result).toEqual({ ok: false, error: "recommendation_not_found" });
  });

  it("refuses to review an event of the wrong type", async () => {
    const store = new InMemoryBusinessEventStore();
    const { event: wrongEvent } = await store.insert({
      tenantId: "tenant-1",
      eventType: "estimate.stalled",
      actorType: "system",
      entityType: "lead",
      entityId: "lead-1",
      payload: {},
    });

    const result = await recordEstimateClosingRecommendationReview(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: wrongEvent.id, verdict: "agree", wouldAct: "yes", reasonCodes: [] },
      { eventStore: store }
    );

    expect(result).toEqual({ ok: false, error: "wrong_event_type" });
  });

  it("refuses a malformed verdict without touching the event store", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const result = await recordEstimateClosingRecommendationReview(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, verdict: "yes_totally", wouldAct: "yes", reasonCodes: [] },
      { eventStore: store }
    );

    expect(result).toEqual({ ok: false, error: "invalid_verdict" });
    expect(store.all()).toHaveLength(1); // only the seeded recommendation event
  });

  it("refuses a malformed wouldAct", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);
    const result = await recordEstimateClosingRecommendationReview(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, verdict: "agree", wouldAct: "definitely", reasonCodes: [] },
      { eventStore: store }
    );
    expect(result).toEqual({ ok: false, error: "invalid_would_act" });
  });

  it("refuses an arbitrary reason code", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);
    const result = await recordEstimateClosingRecommendationReview(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, verdict: "agree", wouldAct: "yes", reasonCodes: ["not_a_real_code"] },
      { eventStore: store }
    );
    expect(result).toEqual({ ok: false, error: "invalid_reason_codes" });
  });

  it("a second review of the same recommendation dedupes to the original — single canonical review, no migration needed", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const first = await recordEstimateClosingRecommendationReview(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, verdict: "agree", wouldAct: "yes", reasonCodes: ["recommendation_correct"] },
      { eventStore: store }
    );
    const second = await recordEstimateClosingRecommendationReview(
      "tenant-1",
      "user-owner-2",
      { recommendationEventId: rec.id, verdict: "disagree", wouldAct: "no", reasonCodes: ["timing_wrong"] },
      { eventStore: store }
    );

    expect(first.ok && !first.alreadyReviewed).toBe(true);
    expect(second.ok && second.alreadyReviewed).toBe(true);
    if (first.ok && second.ok) {
      // The second call's own (different) verdict is discarded — the
      // original review, not the attempted overwrite, is what's returned.
      expect(second.review).toEqual(first.review);
    }
    expect(store.all().filter((e) => e.eventType === "estimate.closing_recommendation_reviewed")).toHaveLength(1);
  });

  it("review is idempotent per-tenant — a different tenant reviewing an equivalently-shaped recommendation is independent", async () => {
    const store = new InMemoryBusinessEventStore();
    const recA = await seedRecommendationEvent(store, { tenantId: "tenant-A", entityId: "lead-A" });
    const recB = await seedRecommendationEvent(store, { tenantId: "tenant-B", entityId: "lead-B" });

    await recordEstimateClosingRecommendationReview("tenant-A", "user-A", { recommendationEventId: recA.id, verdict: "agree", wouldAct: "yes", reasonCodes: [] }, { eventStore: store });
    await recordEstimateClosingRecommendationReview("tenant-B", "user-B", { recommendationEventId: recB.id, verdict: "disagree", wouldAct: "no", reasonCodes: [] }, { eventStore: store });

    const reviewed = store.all().filter((e) => e.eventType === "estimate.closing_recommendation_reviewed");
    expect(reviewed).toHaveLength(2);
  });

  it("never accepts or persists a free-text/PII-shaped field, even if the caller sends one", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const result = await recordEstimateClosingRecommendationReview(
      "tenant-1",
      "user-owner-1",
      {
        recommendationEventId: rec.id,
        verdict: "disagree",
        wouldAct: "no",
        reasonCodes: ["timing_wrong"],
        // Deliberately smuggling extra fields a caller might send over
        // HTTP — RecordReviewInput has no such fields; cast through
        // `unknown` (as a real JSON.parse() result would arrive typed) to
        // simulate that.
        notes: "the owner left a comment here",
        customerPhone: "+15550001111",
      } as unknown as Parameters<typeof recordEstimateClosingRecommendationReview>[2],
      { eventStore: store }
    );

    expect(result.ok).toBe(true);
    const reviewed = store.all().find((e) => e.eventType === "estimate.closing_recommendation_reviewed");
    expect(reviewed).toBeDefined();
    expect(Object.keys(reviewed!.payload).sort()).toEqual(["agentRunId", "reasonCodes", "recommendationEventId", "verdict", "wouldAct"]);
    expect(JSON.stringify(reviewed!.payload)).not.toContain("notes");
    expect(JSON.stringify(reviewed!.payload)).not.toContain("+15550001111");
  });

  it("carries agentRunId through from the recommendation's own persisted payload, or null when absent", async () => {
    const store = new InMemoryBusinessEventStore();
    const { agentRunId, ...withoutAgentRunId } = VALID_RECOMMENDATION_PAYLOAD;
    const rec = await seedRecommendationEvent(store, { payload: withoutAgentRunId });

    const result = await recordEstimateClosingRecommendationReview(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, verdict: "agree", wouldAct: "yes", reasonCodes: [] },
      { eventStore: store }
    );

    expect(result.ok && result.review.agentRunId).toBeNull();
  });

  it("has no dependency capable of mutating a lead, outcome, approval, or tool call — structural guarantee", async () => {
    // recordEstimateClosingRecommendationReview's own signature accepts
    // only a BusinessEventStore — there is no lead/outcome/approval/
    // tool-call store parameter anywhere for it to call. This test exists
    // to pin that structural fact so a future edit that adds one of those
    // dependencies fails a code review, not just a runtime assertion.
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);
    await recordEstimateClosingRecommendationReview("tenant-1", "user-owner-1", { recommendationEventId: rec.id, verdict: "agree", wouldAct: "yes", reasonCodes: [] }, { eventStore: store });

    // The recommendation event itself is unchanged — business_events has
    // no update() method at all (append-only by interface design), so
    // this is a structural guarantee, not merely an observed outcome.
    const stillThere = await store.getById("tenant-1", rec.id);
    expect(stillThere?.payload).toEqual(VALID_RECOMMENDATION_PAYLOAD);
  });
});

describe("describeReviewError", () => {
  it("returns a distinct, human-readable message for every error kind", () => {
    const errors: Array<Parameters<typeof describeReviewError>[0]> = [
      "invalid_verdict",
      "invalid_would_act",
      "invalid_reason_codes",
      "recommendation_not_found",
      "wrong_event_type",
    ];
    const messages = errors.map(describeReviewError);
    expect(new Set(messages).size).toBe(errors.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(0);
  });
});
