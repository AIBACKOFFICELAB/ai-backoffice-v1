import { describe, it, expect } from "vitest";
import { PlumbingLead, LeadStatus } from "@/data/leadModel";
import { FollowupSequenceRow } from "@/lib/modules/estimateFollowup/service";
import { computeEstimateLifecycleReadModel } from "./estimateLifecycleReadModel";

const NOW = new Date("2026-02-10T00:00:00.000Z");

function makeLead(id: string, status: LeadStatus, overrides: Partial<PlumbingLead> = {}): PlumbingLead {
  return {
    id,
    date: "2026-01-01T00:00:00.000Z",
    customerName: `Customer ${id}`,
    phone: "555-0100",
    email: "",
    serviceAddress: "1 Test St",
    propertyType: "Single Family Home",
    serviceType: "Water Heater",
    emergency: "No",
    urgency: "Flexible",
    jobDescription: "Test job",
    photosUploaded: "No",
    preferredAppointmentTime: "",
    customerRole: "Owner",
    leadSource: "Website",
    customerNotes: "",
    status,
    estimateAmount: 1000,
    followUpDate: "",
    reviewRequestStatus: "Not Ready",
    internalNotes: "",
    ...overrides,
  };
}

function makeSequence(id: string, leadId: string, overrides: Partial<FollowupSequenceRow> = {}): FollowupSequenceRow {
  return {
    id,
    leadId,
    status: "active",
    estimateSentAt: "2026-02-01T00:00:00.000Z",
    day1DueAt: "2026-02-02T00:00:00.000Z",
    day3DueAt: "2026-02-04T00:00:00.000Z",
    day7DueAt: "2026-02-08T00:00:00.000Z",
    day1SentAt: null,
    day3SentAt: null,
    day7SentAt: null,
    lastReplyAt: null,
    stoppedReason: null,
    ...overrides,
  };
}

describe("computeEstimateLifecycleReadModel — zero state", () => {
  it("returns all-zero, truthful figures for no leads/sequences at all", () => {
    const model = computeEstimateLifecycleReadModel([], [], NOW);
    expect(model).toEqual({
      estimatesSent: 0,
      activeFollowupSequences: 0,
      replied: 0,
      completedDay7: 0,
      stopped: 0,
      stalledEligible: 0,
      openEstimateValue: 0,
      won: 0,
      lost: 0,
      diagnostics: [],
      leads: [],
    });
  });
});

describe("computeEstimateLifecycleReadModel — totals", () => {
  it("counts estimatesSent and openEstimateValue only for leads at Estimate Sent", () => {
    const leads = [makeLead("l1", "Estimate Sent", { estimateAmount: 1000 }), makeLead("l2", "Estimate Sent", { estimateAmount: 2500 }), makeLead("l3", "New", { estimateAmount: 999 })];
    const sequences = [makeSequence("s1", "l1"), makeSequence("s2", "l2")];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.estimatesSent).toBe(2);
    expect(model.openEstimateValue).toBe(3500);
  });

  it("buckets sequences by their own status", () => {
    const leads = [
      makeLead("l1", "Estimate Sent"),
      makeLead("l2", "Estimate Sent"),
      makeLead("l3", "Estimate Sent"),
      makeLead("l4", "Won"),
    ];
    const sequences = [
      makeSequence("s1", "l1", { status: "active" }),
      makeSequence("s2", "l2", { status: "replied" }),
      makeSequence("s3", "l3", { status: "completed" }),
      makeSequence("s4", "l4", { status: "stopped" }),
    ];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.activeFollowupSequences).toBe(1);
    expect(model.replied).toBe(1);
    expect(model.completedDay7).toBe(1);
    expect(model.stopped).toBe(1);
  });

  it("excludes an active sequence whose lead has moved off Estimate Sent from activeFollowupSequences (Codex review finding on PR #23) — it can never become Shadow-eligible, so counting it would make buildShadowReadinessLines' claim false", () => {
    const leads = [makeLead("l1", "Contacted")]; // reverted by hand after being sent
    const sequences = [makeSequence("s1", "l1", { status: "active" })];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.activeFollowupSequences).toBe(0);
    expect(model.diagnostics).toContainEqual({ code: "sequence_without_estimate_sent_status", leadId: "l1", sequenceId: "s1" });
  });

  it("excludes an active sequence whose lead is now terminal (Won/Lost/Completed but not yet stopped) from activeFollowupSequences", () => {
    const leads = [makeLead("l1", "Won")];
    const sequences = [makeSequence("s1", "l1", { status: "active" })];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.activeFollowupSequences).toBe(0);
  });

  it("counts won/lost only for leads that are actually estimate-backed (have/had a follow-up sequence) — never a lead that reached Won/Lost with no tracked estimate (Codex review finding on PR #23)", () => {
    const leads = [
      makeLead("l1", "Won"), // estimate-backed: has a sequence
      makeLead("l2", "Won"), // NOT estimate-backed: no sequence at all (e.g. New -> Won directly)
      makeLead("l3", "Lost"), // estimate-backed
      makeLead("l4", "Lost"), // NOT estimate-backed
    ];
    const sequences = [makeSequence("s1", "l1", { status: "stopped" }), makeSequence("s3", "l3", { status: "stopped" })];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.won).toBe(1);
    expect(model.lost).toBe(1);
  });

  it("counts an estimate-backed won/lost lead regardless of its sequence's own terminal sub-status", () => {
    const leads = [makeLead("l1", "Won")];
    const model = computeEstimateLifecycleReadModel(leads, [makeSequence("s1", "l1", { status: "completed" })], NOW);
    expect(model.won).toBe(1);
  });

  it("never conflates estimate value with revenue — openEstimateValue is a plain sum, not a claimed outcome", () => {
    const leads = [makeLead("l1", "Estimate Sent", { estimateAmount: 5000 })];
    const model = computeEstimateLifecycleReadModel(leads, [makeSequence("s1", "l1")], NOW);
    expect(model).not.toHaveProperty("revenueRecovered");
    expect(model.openEstimateValue).toBe(5000);
  });
});

describe("computeEstimateLifecycleReadModel — Shadow readiness (no artificial acceleration)", () => {
  it("is NOT stalled before day 7", () => {
    const leads = [makeLead("l1", "Estimate Sent")];
    const sequences = [makeSequence("s1", "l1", { day7DueAt: "2026-02-20T00:00:00.000Z" })];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.stalledEligible).toBe(0);
    expect(model.leads[0].shadowStalled).toBe(false);
    expect(model.leads[0].shadowEligible).toBe(true);
  });

  it("IS stalled exactly at/after day 7 when all conditions hold", () => {
    const leads = [makeLead("l1", "Estimate Sent")];
    const sequences = [makeSequence("s1", "l1", { day7DueAt: "2026-02-08T00:00:00.000Z" })];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.stalledEligible).toBe(1);
    expect(model.leads[0].shadowStalled).toBe(true);
  });

  it("a reply blocks eligibility and stalled-ness", () => {
    const leads = [makeLead("l1", "Estimate Sent")];
    const sequences = [makeSequence("s1", "l1", { day7DueAt: "2026-02-08T00:00:00.000Z", status: "replied", lastReplyAt: "2026-02-05T00:00:00.000Z" })];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.stalledEligible).toBe(0);
    expect(model.leads[0].shadowEligible).toBe(false);
  });

  it("a status change away from Estimate Sent blocks eligibility (lead no longer appears as an open estimate at all)", () => {
    const leads = [makeLead("l1", "Won")];
    const sequences = [makeSequence("s1", "l1", { day7DueAt: "2026-02-08T00:00:00.000Z", status: "stopped" })];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.stalledEligible).toBe(0);
    expect(model.leads).toHaveLength(0); // leads[] only ever lists CURRENT Estimate Sent leads
  });

  it("no sequence blocks eligibility entirely and is flagged as a diagnostic, not silently ignored", () => {
    const leads = [makeLead("l1", "Estimate Sent")];
    const model = computeEstimateLifecycleReadModel(leads, [], NOW);
    expect(model.stalledEligible).toBe(0);
    expect(model.diagnostics).toContainEqual({ code: "estimate_sent_missing_sequence", leadId: "l1", sequenceId: null });
  });
});

describe("computeEstimateLifecycleReadModel — diagnostics", () => {
  it("flags Estimate Sent without a sequence", () => {
    const model = computeEstimateLifecycleReadModel([makeLead("l1", "Estimate Sent")], [], NOW);
    expect(model.diagnostics).toEqual([{ code: "estimate_sent_missing_sequence", leadId: "l1", sequenceId: null }]);
  });

  it("flags a sequence whose lead is no longer at Estimate Sent and isn't terminal either", () => {
    const leads = [makeLead("l1", "Contacted")];
    const sequences = [makeSequence("s1", "l1", { status: "active" })];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.diagnostics).toContainEqual({ code: "sequence_without_estimate_sent_status", leadId: "l1", sequenceId: "s1" });
  });

  it("flags a terminal lead with a still-active sequence", () => {
    const leads = [makeLead("l1", "Won")];
    const sequences = [makeSequence("s1", "l1", { status: "active" })];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.diagnostics).toContainEqual({ code: "terminal_lead_with_active_sequence", leadId: "l1", sequenceId: "s1" });
  });

  it("does NOT flag a terminal lead whose sequence has already stopped", () => {
    const leads = [makeLead("l1", "Won")];
    const sequences = [makeSequence("s1", "l1", { status: "stopped" })];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.diagnostics).toEqual([]);
  });

  it("flags a malformed (zero/negative/non-finite) estimate amount on an Estimate Sent lead", () => {
    const leads = [makeLead("l1", "Estimate Sent", { estimateAmount: 0 })];
    const sequences = [makeSequence("s1", "l1")];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.diagnostics).toContainEqual({ code: "malformed_estimate_amount", leadId: "l1", sequenceId: "s1" });
    expect(model.openEstimateValue).toBe(0);
  });

  it("does NOT flag a perfectly healthy Estimate Sent + active-sequence pair", () => {
    const leads = [makeLead("l1", "Estimate Sent", { estimateAmount: 1200 })];
    const sequences = [makeSequence("s1", "l1")];
    const model = computeEstimateLifecycleReadModel(leads, sequences, NOW);
    expect(model.diagnostics).toEqual([]);
  });

  it("tenant isolation: only ever sees the leads/sequences it was given — this test documents that the read model performs no cross-tenant fetch of its own", () => {
    // computeEstimateLifecycleReadModel is pure and takes already-tenant-scoped
    // arrays; there is no tenantId parameter for it to get wrong. The real
    // isolation guarantee lives in getLeads(tenantId) /
    // getEstimateFollowupSequencesForTenant(tenantId) — this test simply
    // confirms the compute function only ever reflects what it's handed.
    const leads = [makeLead("l1", "Estimate Sent")];
    const model = computeEstimateLifecycleReadModel(leads, [], NOW);
    expect(model.leads.map((l) => l.leadId)).toEqual(["l1"]);
  });
});

describe("computeEstimateLifecycleReadModel — nextFollowupStep", () => {
  it("is day1 when nothing has sent yet", () => {
    const model = computeEstimateLifecycleReadModel([makeLead("l1", "Estimate Sent")], [makeSequence("s1", "l1")], NOW);
    expect(model.leads[0].nextFollowupStep).toBe("day1");
  });

  it("is day3 once day1 has sent", () => {
    const model = computeEstimateLifecycleReadModel([makeLead("l1", "Estimate Sent")], [makeSequence("s1", "l1", { day1SentAt: "2026-02-02T00:00:00.000Z" })], NOW);
    expect(model.leads[0].nextFollowupStep).toBe("day3");
  });

  it("is null once the sequence is no longer active", () => {
    const model = computeEstimateLifecycleReadModel([makeLead("l1", "Estimate Sent")], [makeSequence("s1", "l1", { status: "completed", day1SentAt: "x", day3SentAt: "x", day7SentAt: "x" })], NOW);
    expect(model.leads[0].nextFollowupStep).toBeNull();
  });
});
