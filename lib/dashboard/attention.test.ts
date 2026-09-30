import { describe, it, expect } from "vitest";
import {
  isOverdueFollowUp,
  isUnresolvedEmergency,
  countUnreviewedRecommendations,
  buildUnreviewedRecommendationAttentionItem,
  buildMissingFollowThroughAttentionItem,
  buildActiveAgentFailureAttentionItems,
} from "./revenueCommandCenter";
import { PlumbingLead } from "@/data/leadModel";
import { AgentRun } from "@/lib/agents/runStore";

function makeLead(overrides: Partial<PlumbingLead> = {}): PlumbingLead {
  return {
    id: "lead-1",
    date: "2026-08-01",
    customerName: "Test Customer",
    phone: "555-0100",
    email: "test@example.com",
    serviceAddress: "123 Main St",
    propertyType: "Single Family Home",
    serviceType: "Water Heater",
    emergency: "No",
    urgency: "Flexible",
    jobDescription: "Test job",
    photosUploaded: "No",
    preferredAppointmentTime: "",
    customerRole: "Owner",
    leadSource: "Google",
    customerNotes: "",
    status: "New",
    estimateAmount: 0,
    followUpDate: "",
    reviewRequestStatus: "Not Ready",
    internalNotes: "",
    ...overrides,
  };
}

const TODAY = "2026-08-30";

describe("isOverdueFollowUp", () => {
  it("is true for a due-or-past follow-up date on an open lead", () => {
    expect(isOverdueFollowUp(makeLead({ followUpDate: "2026-08-29", status: "Contacted" }), TODAY)).toBe(true);
    expect(isOverdueFollowUp(makeLead({ followUpDate: TODAY, status: "Contacted" }), TODAY)).toBe(true);
  });

  it("is false for a future follow-up date", () => {
    expect(isOverdueFollowUp(makeLead({ followUpDate: "2026-09-15", status: "Contacted" }), TODAY)).toBe(false);
  });

  it("is false with no follow-up date set", () => {
    expect(isOverdueFollowUp(makeLead({ followUpDate: "" }), TODAY)).toBe(false);
  });

  it("is false for a lead already Completed or Lost, even if the date is overdue", () => {
    expect(isOverdueFollowUp(makeLead({ followUpDate: "2026-08-01", status: "Completed" }), TODAY)).toBe(false);
    expect(isOverdueFollowUp(makeLead({ followUpDate: "2026-08-01", status: "Lost" }), TODAY)).toBe(false);
  });
});

describe("isUnresolvedEmergency", () => {
  it("is true for an emergency lead still in progress", () => {
    expect(isUnresolvedEmergency(makeLead({ emergency: "Yes", status: "New" }))).toBe(true);
    expect(isUnresolvedEmergency(makeLead({ emergency: "Yes", status: "Scheduled" }))).toBe(true);
  });

  it("is false for a non-emergency lead", () => {
    expect(isUnresolvedEmergency(makeLead({ emergency: "No", status: "New" }))).toBe(false);
  });

  it("is false once an emergency lead reaches a terminal status", () => {
    expect(isUnresolvedEmergency(makeLead({ emergency: "Yes", status: "Won" }))).toBe(false);
    expect(isUnresolvedEmergency(makeLead({ emergency: "Yes", status: "Lost" }))).toBe(false);
    expect(isUnresolvedEmergency(makeLead({ emergency: "Yes", status: "Completed" }))).toBe(false);
  });
});

/** P1 Sprint 5 §14 — first-recommendation attention state. */
describe("countUnreviewedRecommendations", () => {
  it("is zero when no recommendations exist — no fake notification when count is 0", () => {
    expect(countUnreviewedRecommendations([], [])).toBe(0);
  });

  it("is zero when every recommendation has a matching review", () => {
    const recs = [{ recommendationEventId: "r1" }, { recommendationEventId: "r2" }];
    const reviews = [{ recommendationEventId: "r1" }, { recommendationEventId: "r2" }];
    expect(countUnreviewedRecommendations(recs, reviews)).toBe(0);
  });

  it("counts only recommendations with no matching review", () => {
    const recs = [{ recommendationEventId: "r1" }, { recommendationEventId: "r2" }, { recommendationEventId: "r3" }];
    const reviews = [{ recommendationEventId: "r1" }];
    expect(countUnreviewedRecommendations(recs, reviews)).toBe(2);
  });

  it("a review for a recommendation not in the window does not affect the count", () => {
    const recs = [{ recommendationEventId: "r1" }];
    const reviews = [{ recommendationEventId: "some-other-recommendation" }];
    expect(countUnreviewedRecommendations(recs, reviews)).toBe(1);
  });
});

/** P1 Sprint 7 §19/§30 — the exact-link attention-card builders. */
describe("buildUnreviewedRecommendationAttentionItem", () => {
  it("A: is null at zero recommendations (never a fake notification)", () => {
    expect(buildUnreviewedRecommendationAttentionItem([], null)).toBeNull();
  });

  it("E/G: links directly to the exact recommendation when it is the only one — never a generic link", () => {
    const item = buildUnreviewedRecommendationAttentionItem([{ recommendationEventId: "rec-abc" }], "2026-09-23T11:11:57.000Z");
    expect(item?.href).toBe("/agentic/estimate-closing/recommendations/rec-abc");
    expect(item?.href).not.toBe("/agentic/estimate-closing");
  });

  it("falls back to the workspace link once more than one recommendation shares the gap", () => {
    const item = buildUnreviewedRecommendationAttentionItem(
      [{ recommendationEventId: "rec-a" }, { recommendationEventId: "rec-b" }],
      "2026-09-23T11:11:57.000Z"
    );
    expect(item?.href).toBe("/agentic/estimate-closing");
  });

  it("B: is null once the recommendation has been reviewed (caller passes an already-filtered list)", () => {
    expect(buildUnreviewedRecommendationAttentionItem([], "2026-09-23T11:11:57.000Z")).toBeNull();
  });
});

describe("buildMissingFollowThroughAttentionItem", () => {
  it("C: is visible (non-null) when a recommendation has no follow-through", () => {
    const item = buildMissingFollowThroughAttentionItem([{ recommendationEventId: "rec-abc" }], null);
    expect(item).not.toBeNull();
  });

  it("D: is null once follow-through exists (caller passes an already-filtered list)", () => {
    expect(buildMissingFollowThroughAttentionItem([], null)).toBeNull();
  });

  it("F: the single-recommendation link includes the #actual-follow-through anchor", () => {
    const item = buildMissingFollowThroughAttentionItem([{ recommendationEventId: "rec-abc" }], null);
    expect(item?.href).toBe("/agentic/estimate-closing/recommendations/rec-abc#actual-follow-through");
  });

  it("falls back to the workspace link (no anchor) once more than one recommendation shares the gap", () => {
    const item = buildMissingFollowThroughAttentionItem([{ recommendationEventId: "rec-a" }, { recommendationEventId: "rec-b" }], null);
    expect(item?.href).toBe("/agentic/estimate-closing");
  });
});

/** createdAt defaults to whatever completedAt/startedAt is passed — see
 * operationalIncidents.test.ts's identical helper doc comment for why
 * (Codex review, PR #30: retry order is decided by createdAt, not
 * completedAt). */
function makeRun(overrides: Partial<AgentRun> & Pick<AgentRun, "id">): AgentRun {
  const defaultTimestamp = overrides.completedAt ?? overrides.startedAt ?? "2026-09-21T00:00:00.000Z";
  return {
    tenantId: "tenant-1",
    agentId: "agent-1",
    triggerEventId: "trigger-1",
    workflowId: "estimate_closing_shadow",
    status: "failed",
    startedAt: null,
    completedAt: null,
    modelStrategy: {},
    inputContextRef: null,
    outputSummary: null,
    failureReason: "model gateway failed: configuration",
    correlationId: "corr-1",
    createdAt: defaultTimestamp,
    updatedAt: defaultTimestamp,
    ...overrides,
  };
}

describe("buildActiveAgentFailureAttentionItems", () => {
  const agentNameById = new Map([["agent-1", "Estimate Closing Agent"]]);

  it("I: an active failure (no later success) appears in Needs Your Attention", () => {
    const runs = [makeRun({ id: "r1", status: "failed", completedAt: "2026-09-21T00:00:00.000Z" })];
    const items = buildActiveAgentFailureAttentionItems(runs, agentNameById);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("agent_failure");
  });

  it("H: a historical failure (resolved by a later success for the same subject) disappears from Needs Your Attention", () => {
    const runs = [
      makeRun({ id: "r1", status: "failed", completedAt: "2026-09-21T00:00:00.000Z" }),
      makeRun({ id: "r2", status: "failed", completedAt: "2026-09-22T00:00:00.000Z" }),
      makeRun({ id: "r3", status: "succeeded", completedAt: "2026-09-23T00:00:00.000Z" }),
    ];
    const items = buildActiveAgentFailureAttentionItems(runs, agentNameById);
    expect(items).toHaveLength(0);
  });

  it("a newer failure after the resolving success is active again, while the older resolved ones stay hidden", () => {
    const runs = [
      makeRun({ id: "r1", status: "failed", completedAt: "2026-09-21T00:00:00.000Z" }),
      makeRun({ id: "r2", status: "succeeded", completedAt: "2026-09-22T00:00:00.000Z" }),
      makeRun({ id: "r3", status: "failed", completedAt: "2026-09-25T00:00:00.000Z" }),
    ];
    const items = buildActiveAgentFailureAttentionItems(runs, agentNameById);
    expect(items).toHaveLength(1);
    expect(items[0].occurredAt).toBe("2026-09-25T00:00:00.000Z");
  });
});
