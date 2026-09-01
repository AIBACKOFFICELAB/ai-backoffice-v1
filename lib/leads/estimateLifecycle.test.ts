import { describe, it, expect, vi } from "vitest";
import { PlumbingLead } from "@/data/leadModel";
import {
  validateEstimateSentTransition,
  markEstimateSent,
  buildEstimateSentIdempotencyKey,
  type MarkEstimateSentDeps,
} from "./estimateLifecycle";

function makeLead(overrides: Partial<PlumbingLead> = {}): PlumbingLead {
  return {
    id: "lead-1",
    date: "2026-01-01T00:00:00.000Z",
    customerName: "Test Customer",
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
    status: "New",
    estimateAmount: 1500,
    followUpDate: "",
    reviewRequestStatus: "Not Ready",
    internalNotes: "",
    ...overrides,
  };
}

describe("validateEstimateSentTransition", () => {
  it("accepts a valid transition from New with a positive amount", () => {
    expect(validateEstimateSentTransition("New", 1500)).toEqual({ ok: true });
  });

  it("accepts re-invocation against a lead already at Estimate Sent (idempotent retry)", () => {
    expect(validateEstimateSentTransition("Estimate Sent", 1500)).toEqual({ ok: true });
  });

  it("accepts from Contacted and Scheduled", () => {
    expect(validateEstimateSentTransition("Contacted", 1500)).toEqual({ ok: true });
    expect(validateEstimateSentTransition("Scheduled", 1500)).toEqual({ ok: true });
  });

  it("rejects a zero amount", () => {
    expect(validateEstimateSentTransition("New", 0)).toEqual({ ok: false, reason: "invalid_amount" });
  });

  it("rejects a negative amount", () => {
    expect(validateEstimateSentTransition("New", -50)).toEqual({ ok: false, reason: "invalid_amount" });
  });

  it("rejects a non-finite amount", () => {
    expect(validateEstimateSentTransition("New", NaN)).toEqual({ ok: false, reason: "invalid_amount" });
    expect(validateEstimateSentTransition("New", Infinity)).toEqual({ ok: false, reason: "invalid_amount" });
  });

  it("rejects a non-number amount", () => {
    expect(validateEstimateSentTransition("New", "1500" as unknown as number)).toEqual({ ok: false, reason: "invalid_amount" });
  });

  it("refuses Won, Lost, and Completed leads — terminal, regardless of amount", () => {
    expect(validateEstimateSentTransition("Won", 1500)).toEqual({ ok: false, reason: "terminal_status_refused" });
    expect(validateEstimateSentTransition("Lost", 1500)).toEqual({ ok: false, reason: "terminal_status_refused" });
    expect(validateEstimateSentTransition("Completed", 1500)).toEqual({ ok: false, reason: "terminal_status_refused" });
  });

  it("terminal-status refusal takes priority over an invalid amount (one clear reason, not a confusing pair)", () => {
    expect(validateEstimateSentTransition("Won", 0)).toEqual({ ok: false, reason: "terminal_status_refused" });
  });
});

describe("buildEstimateSentIdempotencyKey", () => {
  it("is derived from the lead id alone", () => {
    expect(buildEstimateSentIdempotencyKey("lead-abc")).toBe("estimate.sent:lead-abc");
  });

  it("is stable across repeated calls for the same lead", () => {
    expect(buildEstimateSentIdempotencyKey("lead-abc")).toBe(buildEstimateSentIdempotencyKey("lead-abc"));
  });
});

function makeDeps(enrollResult: { enrolled: boolean; reason?: string; error?: string }): { deps: MarkEstimateSentDeps; emitLifecycleEvent: ReturnType<typeof vi.fn> } {
  const emitLifecycleEvent = vi.fn().mockResolvedValue(undefined);
  return {
    deps: {
      enrollLeadInFollowup: vi.fn().mockResolvedValue(enrollResult),
      emitLifecycleEvent,
    },
    emitLifecycleEvent,
  };
}

describe("markEstimateSent", () => {
  it("newly_sent_enrolled: a fresh transition whose enrollment succeeds", async () => {
    const { deps } = makeDeps({ enrolled: true });
    const result = await markEstimateSent(makeLead({ status: "Estimate Sent" }), "tenant-1", false, "user-1", deps);
    expect(result).toEqual({ outcome: "newly_sent_enrolled", leadId: "lead-1", sequenceCreated: true });
  });

  it("already_sent_reconciled: the lead was already Estimate Sent but had no sequence, and this call created one", async () => {
    const { deps } = makeDeps({ enrolled: true });
    const result = await markEstimateSent(makeLead({ status: "Estimate Sent" }), "tenant-1", true, "user-1", deps);
    expect(result).toEqual({ outcome: "already_sent_reconciled", leadId: "lead-1", sequenceCreated: true });
  });

  it("already_sent_enrolled: enrollment reports already-enrolled (pre-check hit, or lost a concurrent race)", async () => {
    const { deps } = makeDeps({ enrolled: false, reason: "already-enrolled" });
    const result = await markEstimateSent(makeLead({ status: "Estimate Sent" }), "tenant-1", true, "user-1", deps);
    expect(result).toEqual({ outcome: "already_sent_enrolled", leadId: "lead-1", sequenceCreated: false });
  });

  it("a fresh transition that loses a genuine concurrent enrollment race still reports the successful already_sent_enrolled outcome, not a failure", async () => {
    const { deps } = makeDeps({ enrolled: false, reason: "already-enrolled" });
    const result = await markEstimateSent(makeLead({ status: "Estimate Sent" }), "tenant-1", false, "user-1", deps);
    expect(result.outcome).toBe("already_sent_enrolled");
  });

  it("enrollment_failed: a genuine, non-constraint enrollment error", async () => {
    const { deps } = makeDeps({ enrolled: false, reason: "insert-failed", error: "connection reset" });
    const result = await markEstimateSent(makeLead({ status: "Estimate Sent" }), "tenant-1", false, "user-1", deps);
    expect(result).toEqual({ outcome: "enrollment_failed", leadId: "lead-1", sequenceCreated: false });
  });

  it("emits the lifecycle event on every successful outcome", async () => {
    const { deps, emitLifecycleEvent } = makeDeps({ enrolled: true });
    await markEstimateSent(makeLead({ status: "Estimate Sent", estimateAmount: 2500 }), "tenant-1", false, "user-9", deps);
    expect(emitLifecycleEvent).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      leadId: "lead-1",
      estimateAmount: 2500,
      sequenceCreated: true,
      actorUserId: "user-9",
    });
  });

  it("does NOT emit the lifecycle event when enrollment genuinely fails", async () => {
    const { deps, emitLifecycleEvent } = makeDeps({ enrolled: false, reason: "insert-failed" });
    await markEstimateSent(makeLead({ status: "Estimate Sent" }), "tenant-1", false, "user-1", deps);
    expect(emitLifecycleEvent).not.toHaveBeenCalled();
  });

  it("passes actorUserId through as null when no actor is resolved", async () => {
    const { deps, emitLifecycleEvent } = makeDeps({ enrolled: true });
    await markEstimateSent(makeLead({ status: "Estimate Sent" }), "tenant-1", false, null, deps);
    expect(emitLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: null }));
  });
});
