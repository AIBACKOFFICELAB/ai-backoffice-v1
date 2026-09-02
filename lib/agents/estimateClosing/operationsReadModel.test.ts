import { describe, it, expect } from "vitest";
import { computeEstimateClosingOperations, EstimateClosingOperationsInput } from "./operationsReadModel";

function baseInput(overrides: Partial<EstimateClosingOperationsInput> = {}): EstimateClosingOperationsInput {
  return {
    agentStatus: "active",
    shadowEnabled: true,
    recommendationsGenerated: 0,
    recommendationsReviewed: 0,
    latestSuccessfulRecommendationAt: null,
    modelFailureCount: 0,
    latestModelFailureCategory: null,
    malformedRecommendationOrReviewCount: 0,
    lifecycleReadiness: { estimatesSent: 0, activeFollowupSequences: 0, stalledEligible: 0 },
    completedTelemetryEvents: [],
    failedTelemetryEvents: [],
    ...overrides,
  };
}

const COMPLETED_PAYLOAD = {
  scanId: "s1",
  candidatesScanned: 0,
  stalledFound: 0,
  newlyStalled: 0,
  shadowAttempts: 0,
  succeeded: 0,
  alreadyProcessed: 0,
  skipped: 0,
  failed: 0,
  durationMs: 100,
};

describe("computeEstimateClosingOperations", () => {
  it("no telemetry ever recorded — reports a truthful 'no_telemetry' state, never a fabricated healthy/observed status", () => {
    const ops = computeEstimateClosingOperations(baseInput());
    expect(ops.scanTelemetryStatus).toBe("no_telemetry");
    expect(ops.lastScanAt).toBeNull();
    expect(ops.latestScanCounts).toBeNull();
    expect(ops.latestScanFailureCategory).toBeNull();
  });

  it("selects the most recent COMPLETED scan telemetry event when multiple exist", () => {
    const ops = computeEstimateClosingOperations(
      baseInput({
        completedTelemetryEvents: [
          { occurredAt: "2026-09-01T10:00:00.000Z", payload: { ...COMPLETED_PAYLOAD, scanId: "s1" } },
          { occurredAt: "2026-09-02T10:00:00.000Z", payload: { ...COMPLETED_PAYLOAD, scanId: "s2", candidatesScanned: 1, stalledFound: 1, shadowAttempts: 1, succeeded: 1 } },
        ],
      })
    );
    expect(ops.scanTelemetryStatus).toBe("observed");
    expect(ops.lastScanAt).toBe("2026-09-02T10:00:00.000Z");
    expect(ops.latestScanCounts?.scanId).toBe("s2");
    expect(ops.latestScanFailureCategory).toBeNull();
  });

  it("a failure recorded AFTER a prior success correctly overrides the status to failure_recorded", () => {
    const ops = computeEstimateClosingOperations(
      baseInput({
        completedTelemetryEvents: [{ occurredAt: "2026-09-01T10:00:00.000Z", payload: COMPLETED_PAYLOAD }],
        failedTelemetryEvents: [{ occurredAt: "2026-09-02T10:00:00.000Z", payload: { scanId: "s2", errorCategory: "read_failed", durationMs: 50 } }],
      })
    );
    expect(ops.scanTelemetryStatus).toBe("failure_recorded");
    expect(ops.lastScanAt).toBe("2026-09-02T10:00:00.000Z");
    expect(ops.latestScanFailureCategory).toBe("read_failed");
    expect(ops.latestScanCounts).toBeNull();
  });

  it("a success recorded AFTER a prior failure correctly reports observed, not failure_recorded", () => {
    const ops = computeEstimateClosingOperations(
      baseInput({
        completedTelemetryEvents: [{ occurredAt: "2026-09-02T10:00:00.000Z", payload: COMPLETED_PAYLOAD }],
        failedTelemetryEvents: [{ occurredAt: "2026-09-01T10:00:00.000Z", payload: { scanId: "s1", errorCategory: "read_failed", durationMs: 50 } }],
      })
    );
    expect(ops.scanTelemetryStatus).toBe("observed");
  });

  it("malformed scan telemetry payloads are skipped and counted, never trusted or thrown on", () => {
    const ops = computeEstimateClosingOperations(
      baseInput({
        completedTelemetryEvents: [{ occurredAt: "2026-09-01T10:00:00.000Z", payload: { scanId: "bad" } }],
        failedTelemetryEvents: [{ occurredAt: "2026-09-02T10:00:00.000Z", payload: { scanId: "bad2" } }],
      })
    );
    expect(ops.scanTelemetryStatus).toBe("no_telemetry");
    expect(ops.malformedScanTelemetryCount).toBe(2);
  });

  it("recommendationsAwaitingReview reflects generated minus reviewed, and never goes negative", () => {
    expect(computeEstimateClosingOperations(baseInput({ recommendationsGenerated: 5, recommendationsReviewed: 2 })).recommendationsAwaitingReview).toBe(3);
    // Defensive: a review count somehow exceeding generated (e.g. a review
    // whose recommendation later aged out of a differently-bounded window)
    // must never surface as a negative "awaiting" count.
    expect(computeEstimateClosingOperations(baseInput({ recommendationsGenerated: 2, recommendationsReviewed: 5 })).recommendationsAwaitingReview).toBe(0);
  });

  it("model failure count and category pass through untouched — this function trusts its already-resolved input", () => {
    const ops = computeEstimateClosingOperations(baseInput({ modelFailureCount: 3, latestModelFailureCategory: "rate_limited" }));
    expect(ops.modelFailureCount).toBe(3);
    expect(ops.latestModelFailureCategory).toBe("rate_limited");
  });

  it("lifecycle readiness values pass through untouched — this function never re-derives them", () => {
    const readiness = { estimatesSent: 4, activeFollowupSequences: 2, stalledEligible: 1 };
    expect(computeEstimateClosingOperations(baseInput({ lifecycleReadiness: readiness })).lifecycleReadiness).toEqual(readiness);
  });

  it("never conflates opportunity value with recovered revenue — no revenue field exists on the result at all", () => {
    const ops = computeEstimateClosingOperations(baseInput());
    expect(Object.keys(ops)).not.toContain("revenueRecovered");
    expect(Object.keys(ops)).not.toContain("opportunityValueAnalyzed");
    expect(ops.toolCallsAttributable).toBe(0);
    expect(ops.approvalsAttributable).toBe(0);
    expect(ops.customerActionsAttributable).toBe(0);
  });

  it("a not_registered agent still reports whatever real lifecycle numbers were passed in, never zeroed-out by agent status", () => {
    const ops = computeEstimateClosingOperations(baseInput({ agentStatus: "not_registered", lifecycleReadiness: { estimatesSent: 5, activeFollowupSequences: 0, stalledEligible: 0 } }));
    expect(ops.agentStatus).toBe("not_registered");
    expect(ops.lifecycleReadiness.estimatesSent).toBe(5);
  });
});
