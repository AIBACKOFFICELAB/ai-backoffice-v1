import { describe, it, expect } from "vitest";
import { buildEstimateClosingEvidenceTimeline } from "./evidenceTimeline";
import { EstimateClosingRecommendationEvidence } from "./recommendationEvidence";

type Found = Extract<EstimateClosingRecommendationEvidence, { found: true }>;

function baseEvidence(overrides: Partial<Found> = {}): Found {
  return {
    found: true,
    recommendation: {
      recommendationEventId: "rec-1",
      agentRunId: "run-1",
      leadId: "lead-1",
      sequenceId: "seq-1",
      occurredAt: "2026-09-23T11:11:57.770951+00:00",
      recommendation: "owner_review",
      confidence: 0.55,
      reasonCodes: ["no_response_since_sent"],
      suggestedChannel: "none",
      suggestedTiming: "next_scheduled_contact",
      opportunityValue: 50,
      mode: "shadow",
    },
    stalledEventFound: true,
    stalledEventOccurredAt: "2026-09-20T00:00:00.000Z",
    agentRun: null,
    modelInvocation: null,
    sequence: {
      status: "completed",
      estimateSentAt: "2026-09-10T00:00:00.000Z",
      day1SentAt: "2026-09-11T00:00:00.000Z",
      day3SentAt: "2026-09-13T00:00:00.000Z",
      day7SentAt: "2026-09-17T00:00:00.000Z",
      day7DueAt: "2026-09-17T00:00:00.000Z",
      lastReplyAt: null,
    },
    leadStatus: "Estimate Sent",
    leadReceivedAt: "2026-09-09T00:00:00.000Z",
    review: null,
    followThrough: null,
    followThroughOccurredAt: null,
    attributionState: {
      evidenceStage: "RECOMMENDATION_RECORDED",
      attributionStage: "ATTRIBUTION_NOT_ESTABLISHED",
    },
    toolCallExists: false,
    approvalExists: false,
    customerActionExists: false,
    ...overrides,
  } as Found;
}

describe("buildEstimateClosingEvidenceTimeline", () => {
  it("A: orders stages exactly per the directive's stage list", () => {
    const stages = buildEstimateClosingEvidenceTimeline(baseEvidence());
    expect(stages.map((s) => s.kind)).toEqual([
      "lead_received",
      "estimate_sent",
      "day1_followup",
      "day3_followup",
      "day7_followup",
      "estimate_stalled",
      "shadow_recommendation_generated",
      "owner_review_recorded",
      "owner_followthrough_recorded",
      "current_business_disposition",
    ]);
  });

  it("B: missing stages (no review, no follow-through) are marked pending with a null timestamp, never fabricated", () => {
    const stages = buildEstimateClosingEvidenceTimeline(baseEvidence());
    const review = stages.find((s) => s.kind === "owner_review_recorded")!;
    const followThrough = stages.find((s) => s.kind === "owner_followthrough_recorded")!;
    const disposition = stages.find((s) => s.kind === "current_business_disposition")!;
    expect(review.status).toBe("pending");
    expect(review.occurredAt).toBeNull();
    expect(followThrough.status).toBe("pending");
    expect(followThrough.occurredAt).toBeNull();
    expect(disposition.status).toBe("pending");
  });

  it("C: Day 1/3/7 timestamps come from the canonical follow-up sequence, not invented", () => {
    const stages = buildEstimateClosingEvidenceTimeline(baseEvidence());
    expect(stages.find((s) => s.kind === "day1_followup")?.occurredAt).toBe("2026-09-11T00:00:00.000Z");
    expect(stages.find((s) => s.kind === "day3_followup")?.occurredAt).toBe("2026-09-13T00:00:00.000Z");
    expect(stages.find((s) => s.kind === "day7_followup")?.occurredAt).toBe("2026-09-17T00:00:00.000Z");
  });

  it("D: the stalled stage appears exactly once, and is pending when no stalled event was found", () => {
    const stages = buildEstimateClosingEvidenceTimeline(baseEvidence({ stalledEventFound: false, stalledEventOccurredAt: null }));
    const stalledStages = stages.filter((s) => s.kind === "estimate_stalled");
    expect(stalledStages).toHaveLength(1);
    expect(stalledStages[0].status).toBe("pending");
  });

  it("E: the recommendation stage appears exactly once and is always completed (evidence only exists once a recommendation exists)", () => {
    const stages = buildEstimateClosingEvidenceTimeline(baseEvidence());
    const recStages = stages.filter((s) => s.kind === "shadow_recommendation_generated");
    expect(recStages).toHaveLength(1);
    expect(recStages[0].status).toBe("completed");
    expect(recStages[0].occurredAt).toBe("2026-09-23T11:11:57.770951+00:00");
  });

  it("F: the review stage appears exactly once and reflects the canonical review", () => {
    const stages = buildEstimateClosingEvidenceTimeline(
      baseEvidence({
        review: { recommendationEventId: "rec-1", agentRunId: "run-1", verdict: "agree", wouldAct: "no", reasonCodes: ["other"], reviewEventId: "rev-1", occurredAt: "2026-09-24T00:00:00.000Z" },
      })
    );
    const reviewStages = stages.filter((s) => s.kind === "owner_review_recorded");
    expect(reviewStages).toHaveLength(1);
    expect(reviewStages[0].status).toBe("completed");
    expect(reviewStages[0].detail).toContain("Agree");
    expect(reviewStages[0].detail).toContain("Would not act");
  });

  it("G/I: intent (wouldAct) and actual action (actionTaken) may legitimately differ — both are preserved as distinct facts, never reconciled into one", () => {
    const stages = buildEstimateClosingEvidenceTimeline(
      baseEvidence({
        review: { recommendationEventId: "rec-1", agentRunId: "run-1", verdict: "agree", wouldAct: "no", reasonCodes: ["other"], reviewEventId: "rev-1", occurredAt: "2026-09-24T00:00:00.000Z" },
        followThrough: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "other", customerResponse: "not_observed", businessDisposition: "lost" },
        followThroughOccurredAt: "2026-09-25T00:00:00.000Z",
      })
    );
    const reviewStage = stages.find((s) => s.kind === "owner_review_recorded")!;
    const followThroughStage = stages.find((s) => s.kind === "owner_followthrough_recorded")!;
    expect(reviewStage.detail).toContain("Would not act");
    expect(followThroughStage.detail).toContain("Action taken");
    // Neither stage's wording claims the other is wrong/invalid.
    expect(reviewStage.detail).not.toMatch(/wrong|invalid|error|contradiction/i);
    expect(followThroughStage.detail).not.toMatch(/wrong|invalid|error|contradiction/i);
  });

  it("H: the latest follow-through appears as the current observed state (append-only correction semantics preserved — caller supplies the already-resolved CURRENT record)", () => {
    const stages = buildEstimateClosingEvidenceTimeline(
      baseEvidence({
        followThrough: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" },
        followThroughOccurredAt: "2026-09-26T00:00:00.000Z",
      })
    );
    const followThroughStage = stages.find((s) => s.kind === "owner_followthrough_recorded")!;
    expect(followThroughStage.occurredAt).toBe("2026-09-26T00:00:00.000Z");
    expect(followThroughStage.status).toBe("completed");
  });

  it("business disposition is qualified as owner-reported, never presented as a canonical outcome", () => {
    const stages = buildEstimateClosingEvidenceTimeline(
      baseEvidence({
        followThrough: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "other", customerResponse: "not_observed", businessDisposition: "lost" },
        followThroughOccurredAt: "2026-09-25T00:00:00.000Z",
      })
    );
    const disposition = stages.find((s) => s.kind === "current_business_disposition")!;
    expect(disposition.detail).toContain("Owner-reported");
    expect(disposition.detail).not.toMatch(/AI (lost|won|caused)/i);
  });

  it("lead_received is pending (never fabricated) when no lead timestamp is available", () => {
    const stages = buildEstimateClosingEvidenceTimeline(baseEvidence({ leadReceivedAt: null }));
    const stage = stages.find((s) => s.kind === "lead_received")!;
    expect(stage.status).toBe("pending");
    expect(stage.occurredAt).toBeNull();
  });
});
