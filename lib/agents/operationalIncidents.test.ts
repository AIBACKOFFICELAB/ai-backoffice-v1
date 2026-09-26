import { describe, it, expect } from "vitest";
import { classifyAgentRunIncidents, isActiveFailedRun } from "./operationalIncidents";
import { AgentRun } from "./runStore";

/** `createdAt` defaults to whatever `completedAt` (or `startedAt`) is
 * passed, so every existing test below — which expresses ordering via
 * completedAt — keeps meaning what it says now that retry order is
 * decided by createdAt (Codex review, PR #30); tests that need
 * createdAt/completedAt to diverge (to prove the two are no longer
 * conflated) override createdAt explicitly. */
function run(overrides: Partial<AgentRun> & Pick<AgentRun, "id">): AgentRun {
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
    failureReason: null,
    correlationId: "corr-1",
    createdAt: defaultTimestamp,
    updatedAt: defaultTimestamp,
    ...overrides,
  };
}

describe("classifyAgentRunIncidents", () => {
  it("A: a failure with no later success is ACTIVE", () => {
    const runs = [run({ id: "r1", status: "failed", completedAt: "2026-09-21T00:00:00.000Z" })];
    const classified = classifyAgentRunIncidents(runs);
    expect(classified.get("r1")?.state).toBe("active");
    expect(isActiveFailedRun("r1", classified)).toBe(true);
  });

  it("B: a failure followed by a successful run for the same workflow/subject is resolved_by_later_success", () => {
    const runs = [
      run({ id: "r1", status: "failed", completedAt: "2026-09-21T00:00:00.000Z" }),
      run({ id: "r2", status: "succeeded", completedAt: "2026-09-23T00:00:00.000Z" }),
    ];
    const classified = classifyAgentRunIncidents(runs);
    expect(classified.get("r1")?.state).toBe("resolved_by_later_success");
    expect(classified.get("r1")?.resolvedByRunId).toBe("r2");
    expect(classified.get("r1")?.resolvedByOccurredAt).toBe("2026-09-23T00:00:00.000Z");
    expect(isActiveFailedRun("r1", classified)).toBe(false);
    // the resolving success is not itself a "failed" entry
    expect(classified.has("r2")).toBe(false);
  });

  it("C: multiple failures followed by one success are all resolved_by_later_success, resolved by the SAME earliest qualifying success", () => {
    const runs = [
      run({ id: "r1", status: "failed", completedAt: "2026-09-21T00:00:00.000Z" }),
      run({ id: "r2", status: "failed", completedAt: "2026-09-22T00:00:00.000Z" }),
      run({ id: "r3", status: "succeeded", completedAt: "2026-09-23T00:00:00.000Z" }),
    ];
    const classified = classifyAgentRunIncidents(runs);
    expect(classified.get("r1")?.state).toBe("resolved_by_later_success");
    expect(classified.get("r1")?.resolvedByRunId).toBe("r3");
    expect(classified.get("r2")?.state).toBe("resolved_by_later_success");
    expect(classified.get("r2")?.resolvedByRunId).toBe("r3");
  });

  it("D: a success followed by a NEWER failure leaves the newer failure ACTIVE", () => {
    const runs = [
      run({ id: "r1", status: "succeeded", completedAt: "2026-09-20T00:00:00.000Z" }),
      run({ id: "r2", status: "failed", completedAt: "2026-09-25T00:00:00.000Z" }),
    ];
    const classified = classifyAgentRunIncidents(runs);
    expect(classified.get("r2")?.state).toBe("active");
  });

  it("E: a success for an UNRELATED workflow does not resolve another workflow's failure (same trigger event id)", () => {
    const runs = [
      run({ id: "r1", status: "failed", workflowId: "estimate_closing_shadow", triggerEventId: "trigger-1", completedAt: "2026-09-21T00:00:00.000Z" }),
      run({ id: "r2", status: "succeeded", workflowId: "some_other_workflow", triggerEventId: "trigger-1", completedAt: "2026-09-23T00:00:00.000Z" }),
    ];
    const classified = classifyAgentRunIncidents(runs);
    expect(classified.get("r1")?.state).toBe("active");
  });

  it("F: a success for an UNRELATED lead/trigger does not resolve another lead's failure (same workflow)", () => {
    const runs = [
      run({ id: "r1", status: "failed", workflowId: "estimate_closing_shadow", triggerEventId: "trigger-lead-A", completedAt: "2026-09-21T00:00:00.000Z" }),
      run({ id: "r2", status: "succeeded", workflowId: "estimate_closing_shadow", triggerEventId: "trigger-lead-B", completedAt: "2026-09-23T00:00:00.000Z" }),
    ];
    const classified = classifyAgentRunIncidents(runs);
    expect(classified.get("r1")?.state).toBe("active");
  });

  it("runs with no triggerEventId are never merged with each other into a false shared subject", () => {
    const runs = [
      run({ id: "r1", status: "failed", triggerEventId: null, completedAt: "2026-09-21T00:00:00.000Z" }),
      run({ id: "r2", status: "succeeded", triggerEventId: null, completedAt: "2026-09-23T00:00:00.000Z" }),
    ];
    const classified = classifyAgentRunIncidents(runs);
    expect(classified.get("r1")?.state).toBe("active");
  });

  it("Codex review, PR #30: a success from a DIFFERENT agent (both lacking workflowId) never resolves another agent's failure for the same trigger event", () => {
    const runs = [
      run({ id: "r1", status: "failed", agentId: "agent-A", workflowId: null, triggerEventId: "trigger-1", completedAt: "2026-09-21T00:00:00.000Z" }),
      run({ id: "r2", status: "succeeded", agentId: "agent-B", workflowId: null, triggerEventId: "trigger-1", completedAt: "2026-09-23T00:00:00.000Z" }),
    ];
    const classified = classifyAgentRunIncidents(runs);
    expect(classified.get("r1")?.state).toBe("active");
  });

  it("Codex review, PR #30: a newer retry (later createdAt) that finishes quickly correctly resolves an older attempt that fails slowly — completion order alone would miss this", () => {
    const runs = [
      // older attempt: created first, takes a long time, fails late
      run({ id: "r1", status: "failed", createdAt: "2026-09-21T00:00:00.000Z", completedAt: "2026-09-25T00:00:00.000Z" }),
      // newer retry: created after r1, but succeeds (and completes) before r1 even finishes
      run({ id: "r2", status: "succeeded", createdAt: "2026-09-22T00:00:00.000Z", completedAt: "2026-09-23T00:00:00.000Z" }),
    ];
    const classified = classifyAgentRunIncidents(runs);
    expect(classified.get("r1")?.state).toBe("resolved_by_later_success");
    expect(classified.get("r1")?.resolvedByRunId).toBe("r2");
  });

  it("Codex review, PR #30: an older attempt that succeeds late does NOT incorrectly resolve a newer attempt that already failed", () => {
    const runs = [
      // older attempt: created first, slow, eventually succeeds late
      run({ id: "r1", status: "succeeded", createdAt: "2026-09-20T00:00:00.000Z", completedAt: "2026-09-26T00:00:00.000Z" }),
      // newer attempt: created after r1 started, fails and completes before r1 finishes
      run({ id: "r2", status: "failed", createdAt: "2026-09-22T00:00:00.000Z", completedAt: "2026-09-23T00:00:00.000Z" }),
    ];
    const classified = classifyAgentRunIncidents(runs);
    // r1's createdAt (Sep 20) is not LATER than r2's createdAt (Sep 22) — r1 is an earlier
    // attempt that merely finished slowly, not a genuine retry — so it must never resolve
    // r2, even though r1's completedAt (Sep 26) is later than r2's completedAt (Sep 23).
    expect(classified.get("r2")?.state).toBe("active");
  });

  it("a success exactly equal to (not strictly after) the failure's own timestamp does not resolve it", () => {
    const runs = [
      run({ id: "r1", status: "failed", completedAt: "2026-09-21T00:00:00.000Z" }),
      run({ id: "r2", status: "succeeded", completedAt: "2026-09-21T00:00:00.000Z" }),
    ];
    const classified = classifyAgentRunIncidents(runs);
    expect(classified.get("r1")?.state).toBe("active");
  });

  it("non-failed, non-succeeded runs (pending/running/etc.) are never classified as incidents", () => {
    const runs = [run({ id: "r1", status: "running", completedAt: null, startedAt: "2026-09-21T00:00:00.000Z" })];
    const classified = classifyAgentRunIncidents(runs);
    expect(classified.has("r1")).toBe(false);
  });
});
