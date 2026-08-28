import { describe, it, expect } from "vitest";
import { computeRunStatus, summarizeToolCallStatuses } from "./runStatus";

/**
 * Truthful run-status computation (P0.9 Slice B, finding H-04/B-07). Pure
 * unit tests — no I/O, no store — this is the single centralized rule
 * lib/agents/runtime.ts calls from both runAgent() and
 * resumeAfterApprovalDecision() instead of each computing its own ad-hoc
 * boolean (the pre-Slice-B bug: an all-denied run reported 'succeeded').
 */
describe("computeRunStatus (B-07)", () => {
  it("scenario 12: all tools denied -> 'denied', never 'succeeded'", () => {
    expect(computeRunStatus(["denied", "denied"])).toBe("denied");
  });

  it("all tools succeeded -> 'succeeded'", () => {
    expect(computeRunStatus(["succeeded", "succeeded"])).toBe("succeeded");
  });

  it("scenario 13: a mixture of succeeded and denied -> truthful 'partial'", () => {
    expect(computeRunStatus(["succeeded", "denied"])).toBe("partial");
  });

  it("scenario 15: any genuine execution failure -> 'failed', even alongside a success", () => {
    expect(computeRunStatus(["succeeded", "failed"])).toBe("failed");
  });

  it("documented deterministic tie-break: failure always wins over denied+succeeded 'partial'", () => {
    expect(computeRunStatus(["succeeded", "denied", "failed"])).toBe("failed");
  });

  it("a run with zero tool calls succeeds vacuously", () => {
    expect(computeRunStatus([])).toBe("succeeded");
  });

  it("failure alone (no denials, no successes) -> 'failed'", () => {
    expect(computeRunStatus(["failed"])).toBe("failed");
  });
});

describe("summarizeToolCallStatuses", () => {
  it("counts every status bucket independently", () => {
    expect(summarizeToolCallStatuses(["succeeded", "failed", "denied", "denied", "requires_approval", "pending"])).toEqual({
      succeeded: 1,
      failed: 1,
      denied: 2,
      requiresApproval: 1,
      pending: 1,
    });
  });
});
