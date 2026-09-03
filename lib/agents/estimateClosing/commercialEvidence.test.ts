import { describe, it, expect } from "vitest";
import {
  computeEstimateClosingCommercialEvidence,
  resolveCurrentFollowThroughByRecommendation,
  resolveEstimateClosingAttributionState,
  getEstimateClosingCommercialEvidence,
  fetchFollowThroughEventsForRecommendations,
} from "./commercialEvidence";
import { EstimateClosingRecommendationView } from "./recommendationReadModel";
import { EstimateClosingRecommendationReviewView } from "./evaluationReadModel";
import { InMemoryBusinessEventStore } from "@/lib/events/store";

const TENANT = "tenant-1";

const VALID_RECOMMENDATION_PAYLOAD = {
  recommendation: "follow_up",
  confidence: 0.8,
  reasonCodes: [],
  suggestedChannel: "sms",
  suggestedTiming: "within_24_hours",
  opportunityValue: 4200,
  rationaleLength: 0,
  agentRunId: null,
  sequenceId: null,
};

async function seedRecommendationEvent(store: InMemoryBusinessEventStore, entityId: string) {
  const { event } = await store.insert({
    tenantId: TENANT,
    eventType: "estimate.closing_recommendation_generated",
    actorType: "agent",
    entityType: "lead",
    entityId,
    payload: VALID_RECOMMENDATION_PAYLOAD,
  });
  return event;
}

async function seedFollowThroughEvent(
  store: InMemoryBusinessEventStore,
  causationId: string,
  overrides: { occurredAt?: string; businessDisposition?: string } = {}
) {
  await store.insert({
    tenantId: TENANT,
    eventType: "estimate.closing_recommendation_followthrough_recorded",
    actorType: "user",
    causationId,
    occurredAt: overrides.occurredAt,
    payload: {
      recommendationEventId: causationId,
      actionTaken: "yes",
      actionChannel: "phone",
      customerResponse: "observed",
      businessDisposition: overrides.businessDisposition ?? "pending",
    },
  });
}

function rec(overrides: Partial<EstimateClosingRecommendationView> = {}): EstimateClosingRecommendationView {
  return {
    recommendationEventId: "rec-1",
    agentRunId: "run-1",
    leadId: "lead-1",
    sequenceId: "seq-1",
    occurredAt: "2026-01-01T00:00:00.000Z",
    recommendation: "follow_up",
    confidence: 0.8,
    reasonCodes: [],
    suggestedChannel: "sms",
    suggestedTiming: "within_24_hours",
    opportunityValue: 4200,
    mode: "shadow",
    ...overrides,
  };
}

function review(overrides: Partial<EstimateClosingRecommendationReviewView> = {}): EstimateClosingRecommendationReviewView {
  return {
    recommendationEventId: "rec-1",
    agentRunId: "run-1",
    verdict: "agree",
    wouldAct: "yes",
    reasonCodes: [],
    reviewEventId: "review-1",
    occurredAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

type FollowThroughEventFixture = { causationId: string | null; occurredAt: string; payload: Record<string, unknown> };

function followThroughEvent(overrides: { causationId?: string | null; occurredAt?: string; payload?: Record<string, unknown> } = {}): FollowThroughEventFixture {
  return {
    causationId: overrides.causationId ?? "rec-1",
    occurredAt: overrides.occurredAt ?? "2026-01-03T00:00:00.000Z",
    payload:
      overrides.payload ?? {
        recommendationEventId: "rec-1",
        actionTaken: "yes",
        actionChannel: "phone",
        customerResponse: "observed",
        businessDisposition: "won",
      },
  };
}

describe("resolveCurrentFollowThroughByRecommendation", () => {
  it("returns nothing for zero events", () => {
    const { current, skippedMalformed } = resolveCurrentFollowThroughByRecommendation([]);
    expect(current.size).toBe(0);
    expect(skippedMalformed).toBe(0);
  });

  it("resolves the single event when only one exists per recommendation", () => {
    const { current } = resolveCurrentFollowThroughByRecommendation([followThroughEvent()]);
    expect(current.get("rec-1")?.followThrough.businessDisposition).toBe("won");
  });

  it("a genuine correction: the MOST RECENT event by occurredAt wins, the earlier one is not discarded from history but not surfaced as current", () => {
    const earlier = followThroughEvent({ occurredAt: "2026-01-01T00:00:00.000Z", payload: { recommendationEventId: "rec-1", actionTaken: "later", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" } });
    const later = followThroughEvent({ occurredAt: "2026-01-05T00:00:00.000Z", payload: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "sms", customerResponse: "observed", businessDisposition: "won" } });
    const { current } = resolveCurrentFollowThroughByRecommendation([earlier, later]);
    expect(current.get("rec-1")?.followThrough.businessDisposition).toBe("won");
    expect(current.size).toBe(1);
  });

  it("order of input does not matter — latest-by-occurredAt always wins regardless of array order", () => {
    const earlier = followThroughEvent({ occurredAt: "2026-01-01T00:00:00.000Z", payload: { recommendationEventId: "rec-1", actionTaken: "no", actionChannel: null, customerResponse: "not_observed", businessDisposition: "lost" } });
    const later = followThroughEvent({ occurredAt: "2026-01-05T00:00:00.000Z", payload: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "email", customerResponse: "observed", businessDisposition: "won" } });
    const { current } = resolveCurrentFollowThroughByRecommendation([later, earlier]);
    expect(current.get("rec-1")?.followThrough.businessDisposition).toBe("won");
  });

  it("skips and counts an event with no causationId", () => {
    const { current, skippedMalformed } = resolveCurrentFollowThroughByRecommendation([{ causationId: null, occurredAt: "x", payload: {} as Record<string, unknown> }]);
    expect(current.size).toBe(0);
    expect(skippedMalformed).toBe(1);
  });

  it("skips and counts a malformed payload without crashing", () => {
    const { current, skippedMalformed } = resolveCurrentFollowThroughByRecommendation([{ causationId: "rec-1", occurredAt: "x", payload: { actionTaken: "not_a_real_value" } }]);
    expect(current.size).toBe(0);
    expect(skippedMalformed).toBe(1);
  });

  it("isolates recommendations correctly — one recommendation's records never leak into another's", () => {
    const a = followThroughEvent({ causationId: "rec-A", payload: { recommendationEventId: "rec-A", actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" } });
    const b = followThroughEvent({ causationId: "rec-B", payload: { recommendationEventId: "rec-B", actionTaken: "no", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" } });
    const { current } = resolveCurrentFollowThroughByRecommendation([a, b]);
    expect(current.get("rec-A")?.followThrough.businessDisposition).toBe("won");
    expect(current.get("rec-B")?.followThrough.businessDisposition).toBe("pending");
  });
});

describe("computeEstimateClosingCommercialEvidence", () => {
  it("zero state: no recommendations produces all-zero, truthful, non-fabricated figures", () => {
    const result = computeEstimateClosingCommercialEvidence({ recommendations: [], reviews: [], followThroughEvents: [], leadStatusByLeadId: new Map() });
    expect(result).toMatchObject({
      recommendationsGenerated: 0,
      recommendationsReviewed: 0,
      recommendationsAwaitingReview: 0,
      followthroughRecorded: 0,
      actedYes: 0,
      actedNo: 0,
      actedLater: 0,
      customerResponsesObserved: 0,
      ownerReportedWon: 0,
      ownerReportedLost: 0,
      ownerReportedPending: 0,
      recommendationsWithoutFollowthrough: 0,
      followThroughCoverageRate: null,
      malformedFollowThroughCount: 0,
      diagnostics: [],
    });
  });

  it("follow-through coverage denominator is correct — recommendationsGenerated, never a different window", () => {
    const recs = [rec({ recommendationEventId: "rec-1" }), rec({ recommendationEventId: "rec-2" }), rec({ recommendationEventId: "rec-3" })];
    const events = [followThroughEvent({ causationId: "rec-1" })];
    const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews: [], followThroughEvents: events, leadStatusByLeadId: new Map() });
    expect(result.recommendationsGenerated).toBe(3);
    expect(result.followthroughRecorded).toBe(1);
    expect(result.recommendationsWithoutFollowthrough).toBe(2);
    expect(result.followThroughCoverageRate).toBeCloseTo(1 / 3);
  });

  it("acted Yes/No/Later counts are correct", () => {
    const recs = [rec({ recommendationEventId: "rec-1" }), rec({ recommendationEventId: "rec-2" }), rec({ recommendationEventId: "rec-3" })];
    const events = [
      followThroughEvent({ causationId: "rec-1", payload: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" } }),
      followThroughEvent({ causationId: "rec-2", payload: { recommendationEventId: "rec-2", actionTaken: "no", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" } }),
      followThroughEvent({ causationId: "rec-3", payload: { recommendationEventId: "rec-3", actionTaken: "later", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" } }),
    ];
    const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews: [], followThroughEvents: events, leadStatusByLeadId: new Map() });
    expect(result.actedYes).toBe(1);
    expect(result.actedNo).toBe(1);
    expect(result.actedLater).toBe(1);
  });

  it("customer response observed count is correct", () => {
    const recs = [rec({ recommendationEventId: "rec-1" }), rec({ recommendationEventId: "rec-2" })];
    const events = [
      followThroughEvent({ causationId: "rec-1", payload: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "pending" } }),
      followThroughEvent({ causationId: "rec-2", payload: { recommendationEventId: "rec-2", actionTaken: "yes", actionChannel: "phone", customerResponse: "not_observed", businessDisposition: "pending" } }),
    ];
    const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews: [], followThroughEvents: events, leadStatusByLeadId: new Map() });
    expect(result.customerResponsesObserved).toBe(1);
  });

  it("owner-reported disposition counts are correct", () => {
    const recs = [rec({ recommendationEventId: "rec-1" }), rec({ recommendationEventId: "rec-2" }), rec({ recommendationEventId: "rec-3" })];
    const events = [
      followThroughEvent({ causationId: "rec-1", payload: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" } }),
      followThroughEvent({ causationId: "rec-2", payload: { recommendationEventId: "rec-2", actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "lost" } }),
      followThroughEvent({ causationId: "rec-3", payload: { recommendationEventId: "rec-3", actionTaken: "no", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" } }),
    ];
    const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews: [], followThroughEvents: events, leadStatusByLeadId: new Map() });
    expect(result.ownerReportedWon).toBe(1);
    expect(result.ownerReportedLost).toBe(1);
    expect(result.ownerReportedPending).toBe(1);
  });

  it("recommendationsReviewed and recommendationsAwaitingReview reflect the review set independently of follow-through", () => {
    const recs = [rec({ recommendationEventId: "rec-1" }), rec({ recommendationEventId: "rec-2" })];
    const reviews = [review({ recommendationEventId: "rec-1" })];
    const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews, followThroughEvents: [], leadStatusByLeadId: new Map() });
    expect(result.recommendationsReviewed).toBe(1);
    expect(result.recommendationsAwaitingReview).toBe(1);
  });

  it("malformed follow-through events are skipped and counted, never crash the read model", () => {
    const recs = [rec({ recommendationEventId: "rec-1" })];
    const events = [{ causationId: "rec-1", occurredAt: "x", payload: { actionTaken: "garbage" } }];
    const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews: [], followThroughEvents: events, leadStatusByLeadId: new Map() });
    expect(result.followthroughRecorded).toBe(0);
    expect(result.malformedFollowThroughCount).toBe(1);
  });

  describe("diagnostics — data-quality signals, never auto-corrected", () => {
    it("matching lead status produces no disposition mismatch diagnostic", () => {
      const recs = [rec({ recommendationEventId: "rec-1", leadId: "lead-1" })];
      const events = [followThroughEvent({ causationId: "rec-1", payload: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" } })];
      const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews: [], followThroughEvents: events, leadStatusByLeadId: new Map([["lead-1", "Won"]]) });
      expect(result.diagnostics.filter((d) => d.code === "disposition_lead_status_mismatch")).toHaveLength(0);
    });

    it("conflicting lead status (follow-through says Won, lead is still Estimate Sent) surfaces a mismatch diagnostic", () => {
      const recs = [rec({ recommendationEventId: "rec-1", leadId: "lead-1" })];
      const events = [followThroughEvent({ causationId: "rec-1", payload: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" } })];
      const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews: [], followThroughEvents: events, leadStatusByLeadId: new Map([["lead-1", "Estimate Sent"]]) });
      expect(result.diagnostics).toContainEqual({ code: "disposition_lead_status_mismatch", recommendationEventId: "rec-1" });
    });

    it("conflicting lead status (follow-through says Lost, lead says Won) surfaces a mismatch diagnostic", () => {
      const recs = [rec({ recommendationEventId: "rec-1", leadId: "lead-1" })];
      const events = [followThroughEvent({ causationId: "rec-1", payload: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "lost" } })];
      const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews: [], followThroughEvents: events, leadStatusByLeadId: new Map([["lead-1", "Won"]]) });
      expect(result.diagnostics).toContainEqual({ code: "disposition_lead_status_mismatch", recommendationEventId: "rec-1" });
    });

    it("never auto-corrects — the reported disposition/lead status counts stay exactly as recorded, mismatch or not", () => {
      const recs = [rec({ recommendationEventId: "rec-1", leadId: "lead-1" })];
      const events = [followThroughEvent({ causationId: "rec-1", payload: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" } })];
      const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews: [], followThroughEvents: events, leadStatusByLeadId: new Map([["lead-1", "Lost"]]) });
      // The mismatch is surfaced, but ownerReportedWon still counts the
      // owner's own answer exactly as given — nothing is silently flipped.
      expect(result.ownerReportedWon).toBe(1);
      expect(result.diagnostics).toContainEqual({ code: "disposition_lead_status_mismatch", recommendationEventId: "rec-1" });
    });

    it("a follow-through event recorded before its own recommendation surfaces a data-integrity diagnostic", () => {
      const recs = [rec({ recommendationEventId: "rec-1", occurredAt: "2026-01-10T00:00:00.000Z" })];
      const events = [followThroughEvent({ causationId: "rec-1", occurredAt: "2026-01-01T00:00:00.000Z" })];
      const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews: [], followThroughEvents: events, leadStatusByLeadId: new Map() });
      expect(result.diagnostics).toContainEqual({ code: "followthrough_before_recommendation", recommendationEventId: "rec-1" });
    });

    it("customer response observed without a recorded action surfaces a diagnostic", () => {
      const recs = [rec({ recommendationEventId: "rec-1" })];
      const events = [followThroughEvent({ causationId: "rec-1", payload: { recommendationEventId: "rec-1", actionTaken: "no", actionChannel: null, customerResponse: "observed", businessDisposition: "pending" } })];
      const result = computeEstimateClosingCommercialEvidence({ recommendations: recs, reviews: [], followThroughEvents: events, leadStatusByLeadId: new Map() });
      expect(result.diagnostics).toContainEqual({ code: "response_observed_without_action", recommendationEventId: "rec-1" });
    });
  });
});

describe("resolveEstimateClosingAttributionState — the pure evidence-ladder resolver", () => {
  it("recommendation only", () => {
    const state = resolveEstimateClosingAttributionState({ hasReview: false, actionTaken: null, customerResponse: null, businessDisposition: null });
    expect(state.evidenceStage).toBe("RECOMMENDATION_RECORDED");
  });

  it("+ owner review", () => {
    const state = resolveEstimateClosingAttributionState({ hasReview: true, actionTaken: null, customerResponse: null, businessDisposition: null });
    expect(state.evidenceStage).toBe("OWNER_REVIEW_RECORDED");
  });

  it("+ actual owner action", () => {
    const state = resolveEstimateClosingAttributionState({ hasReview: true, actionTaken: "yes", customerResponse: null, businessDisposition: null });
    expect(state.evidenceStage).toBe("OWNER_ACTION_RECORDED");
  });

  it("+ response", () => {
    const state = resolveEstimateClosingAttributionState({ hasReview: true, actionTaken: "yes", customerResponse: "observed", businessDisposition: null });
    expect(state.evidenceStage).toBe("CUSTOMER_RESPONSE_OBSERVED");
  });

  it("+ disposition", () => {
    const state = resolveEstimateClosingAttributionState({ hasReview: true, actionTaken: "yes", customerResponse: "observed", businessDisposition: "won" });
    expect(state.evidenceStage).toBe("BUSINESS_DISPOSITION_OBSERVED");
  });

  it("attribution is still not established without a canonical outcome — regardless of how far the evidence ladder reaches", () => {
    const noEvidence = resolveEstimateClosingAttributionState({ hasReview: false, actionTaken: null, customerResponse: null, businessDisposition: null });
    const fullEvidence = resolveEstimateClosingAttributionState({ hasReview: true, actionTaken: "yes", customerResponse: "observed", businessDisposition: "won" });
    expect(noEvidence.attributionStage).toBe("ATTRIBUTION_NOT_ESTABLISHED");
    expect(fullEvidence.attributionStage).toBe("ATTRIBUTION_NOT_ESTABLISHED");
  });

  it("actionTaken 'no'/'later' never advances past OWNER_REVIEW_RECORDED even with a response/disposition present (an internally inconsistent state the diagnostics flag separately)", () => {
    const state = resolveEstimateClosingAttributionState({ hasReview: true, actionTaken: "no", customerResponse: "observed", businessDisposition: "won" });
    expect(state.evidenceStage).toBe("OWNER_REVIEW_RECORDED");
  });

  it("businessDisposition 'unknown' does not advance to BUSINESS_DISPOSITION_OBSERVED — 'unknown' is not an observation", () => {
    const state = resolveEstimateClosingAttributionState({ hasReview: true, actionTaken: "yes", customerResponse: "observed", businessDisposition: "unknown" });
    expect(state.evidenceStage).toBe("CUSTOMER_RESPONSE_OBSERVED");
  });
});

describe("fetchFollowThroughEventsForRecommendations / getEstimateClosingCommercialEvidence — the causationIdIn truncation fix (Codex review finding on PR #25, P1)", () => {
  it("one recommendation with many correction events does not crowd another recommendation's single follow-through record out of the batch fetch", async () => {
    const store = new InMemoryBusinessEventStore();
    const recA = await seedRecommendationEvent(store, "lead-a");
    const recB = await seedRecommendationEvent(store, "lead-b");

    // Recommendation A accumulates many corrections — deliberately more
    // than the number of recommendations in this batch (2), which is
    // exactly the count the store's own causationIdIn default would have
    // capped the WHOLE query at before this fix.
    for (let i = 0; i < 5; i++) {
      await seedFollowThroughEvent(store, recA.id, { occurredAt: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
    // Recommendation B has exactly one, older than several of A's rows —
    // the case that used to get silently dropped.
    await seedFollowThroughEvent(store, recB.id, { occurredAt: "2026-01-01T00:00:00.000Z", businessDisposition: "won" });

    const events = await fetchFollowThroughEventsForRecommendations(TENANT, [recA.id, recB.id], store);
    const { current } = resolveCurrentFollowThroughByRecommendation(
      events.map((e) => ({ causationId: e.causationId, occurredAt: e.occurredAt, payload: e.payload }))
    );

    expect(current.has(recA.id)).toBe(true);
    expect(current.has(recB.id)).toBe(true); // previously could be missing
    expect(current.get(recB.id)?.followThrough.businessDisposition).toBe("won");
  });

  it("getEstimateClosingCommercialEvidence end-to-end: follow-through coverage is correct even when one recommendation has many corrections and another has one", async () => {
    const store = new InMemoryBusinessEventStore();
    const recA = await seedRecommendationEvent(store, "lead-a");
    const recB = await seedRecommendationEvent(store, "lead-b");
    const recC = await seedRecommendationEvent(store, "lead-c"); // no follow-through at all

    for (let i = 0; i < 5; i++) {
      await seedFollowThroughEvent(store, recA.id, { occurredAt: `2026-01-0${i + 1}T00:00:00.000Z` });
    }
    await seedFollowThroughEvent(store, recB.id, { occurredAt: "2026-01-01T00:00:00.000Z" });

    const result = await getEstimateClosingCommercialEvidence(TENANT, {
      eventStore: store,
      getLeadsForTenant: async () => ({ leads: [], source: "supabase" as const }),
    });

    expect(result.recommendationsGenerated).toBe(3);
    expect(result.followthroughRecorded).toBe(2); // A and B, not undercounted to 1
    expect(result.recommendationsWithoutFollowthrough).toBe(1); // only C
  });
});
