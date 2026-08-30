import { describe, it, expect } from "vitest";
import { checkEstimateEligibility, isEstimateStalled, EligibilityContext } from "./eligibility";
import { EstimateClosingLeadContext, EstimateFollowupSequenceContext } from "./types";

const TENANT = "tenant-1";
const NOW = new Date("2026-08-30T12:00:00Z");

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

/** A sequence whose day7DueAt has already passed relative to NOW, by default. */
function makeSequence(overrides: Partial<EstimateFollowupSequenceContext> = {}): EstimateFollowupSequenceContext {
  return {
    id: "seq-1",
    tenantId: TENANT,
    leadId: "lead-1",
    status: "active",
    estimateSentAt: "2026-08-15T09:00:00Z",
    day7DueAt: "2026-08-22T09:00:00Z", // in the past relative to NOW
    lastReplyAt: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<EligibilityContext> = {}): EligibilityContext {
  return { tenantId: TENANT, lead: makeLead(), sequence: makeSequence(), ...overrides };
}

describe("checkEstimateEligibility", () => {
  it("is eligible for a real, sent, unresolved, in-sequence estimate", () => {
    expect(checkEstimateEligibility(ctx())).toEqual({ eligible: true });
  });

  it("rejects a missing lead (no estimate)", () => {
    expect(checkEstimateEligibility(ctx({ lead: null }))).toEqual({ eligible: false, reason: "malformed_context" });
    expect(checkEstimateEligibility(ctx({ lead: undefined }))).toEqual({ eligible: false, reason: "malformed_context" });
  });

  it("rejects a zero-value estimate", () => {
    expect(checkEstimateEligibility(ctx({ lead: makeLead({ estimateAmount: 0 }) }))).toEqual({
      eligible: false,
      reason: "no_estimate_value",
    });
  });

  it("rejects a negative estimate amount as malformed", () => {
    expect(checkEstimateEligibility(ctx({ lead: makeLead({ estimateAmount: -50 }) }))).toEqual({
      eligible: false,
      reason: "no_estimate_value",
    });
  });

  it("rejects a NaN/non-finite estimate amount as malformed context", () => {
    expect(checkEstimateEligibility(ctx({ lead: makeLead({ estimateAmount: NaN }) }))).toEqual({
      eligible: false,
      reason: "malformed_context",
    });
  });

  it("rejects an estimate that has not actually been sent (status never reached Estimate Sent)", () => {
    expect(checkEstimateEligibility(ctx({ lead: makeLead({ status: "Contacted" }) }))).toEqual({
      eligible: false,
      reason: "estimate_not_sent",
    });
  });

  it("rejects a status of Estimate Sent with no corresponding sequence row", () => {
    expect(checkEstimateEligibility(ctx({ sequence: null }))).toEqual({ eligible: false, reason: "estimate_not_sent" });
  });

  it("rejects an already-won estimate", () => {
    expect(checkEstimateEligibility(ctx({ lead: makeLead({ status: "Won" }) }))).toEqual({
      eligible: false,
      reason: "already_won",
    });
  });

  it("rejects a lost estimate", () => {
    expect(checkEstimateEligibility(ctx({ lead: makeLead({ status: "Lost" }) }))).toEqual({
      eligible: false,
      reason: "already_closed",
    });
  });

  it("rejects a completed job", () => {
    expect(checkEstimateEligibility(ctx({ lead: makeLead({ status: "Completed" }) }))).toEqual({
      eligible: false,
      reason: "already_closed",
    });
  });

  it("rejects a record belonging to a different tenant", () => {
    expect(checkEstimateEligibility(ctx({ lead: makeLead({ tenantId: "tenant-2" }) }))).toEqual({
      eligible: false,
      reason: "tenant_mismatch",
    });
  });

  it("rejects a sequence belonging to a different tenant, even if the lead matches", () => {
    expect(checkEstimateEligibility(ctx({ sequence: makeSequence({ tenantId: "tenant-2" }) }))).toEqual({
      eligible: false,
      reason: "estimate_not_sent",
    });
  });

  it("rejects a sequence for a different lead id (defensive cross-record check)", () => {
    expect(checkEstimateEligibility(ctx({ sequence: makeSequence({ leadId: "some-other-lead" }) }))).toEqual({
      eligible: false,
      reason: "estimate_not_sent",
    });
  });

  it("rejects once a reply has already been received", () => {
    expect(checkEstimateEligibility(ctx({ sequence: makeSequence({ status: "replied", lastReplyAt: "2026-08-20T00:00:00Z" }) }))).toEqual({
      eligible: false,
      reason: "reply_already_received",
    });
  });

  it("rejects a stopped sequence", () => {
    expect(checkEstimateEligibility(ctx({ sequence: makeSequence({ status: "stopped" }) }))).toEqual({
      eligible: false,
      reason: "sequence_stopped",
    });
  });

  it("is eligible for a sequence that completed its full Day1/3/7 course with no reply", () => {
    expect(checkEstimateEligibility(ctx({ sequence: makeSequence({ status: "completed" }) }))).toEqual({ eligible: true });
  });
});

describe("isEstimateStalled", () => {
  it("is stalled once eligible and the Day 7 threshold has passed", () => {
    expect(isEstimateStalled(ctx(), NOW)).toBe(true);
  });

  it("is not stalled before the Day 7 threshold, even though otherwise eligible", () => {
    const future = ctx({ sequence: makeSequence({ day7DueAt: "2099-01-01T00:00:00Z" }) });
    expect(isEstimateStalled(future, NOW)).toBe(false);
  });

  it("is never stalled when not eligible at all (e.g. already won)", () => {
    const won = ctx({ lead: makeLead({ status: "Won" }) });
    expect(isEstimateStalled(won, NOW)).toBe(false);
  });

  it("is never stalled with no sequence to measure the threshold from", () => {
    expect(isEstimateStalled(ctx({ sequence: null }), NOW)).toBe(false);
  });

  it("treats the exact threshold instant as stalled (inclusive boundary)", () => {
    const exact = ctx({ sequence: makeSequence({ day7DueAt: NOW.toISOString() }) });
    expect(isEstimateStalled(exact, NOW)).toBe(true);
  });
});
