import { describe, it, expect } from "vitest";
import { computeFollowupDueDates, selectDueStep, FollowupStep } from "./service";

/**
 * Regression coverage for the existing Estimate Follow-up module (Day 1 / 3
 * / 7 sequencing) — required by the P0 directive's "current workflow
 * regression coverage" test, and by
 * docs/constitution/05_MVP_CONSTITUTION.md's Estimate Follow-up spec. These
 * two functions were extracted verbatim from inline logic (see git history
 * on lib/modules/estimateFollowup/service.ts) — behavior must not change.
 */
describe("computeFollowupDueDates", () => {
  it("computes day 1/3/7 due dates exactly 1/3/7 days after sentAt", () => {
    const sentAt = new Date("2026-01-01T00:00:00.000Z");
    const dueDates = computeFollowupDueDates(sentAt);
    expect(dueDates.day1DueAt).toBe("2026-01-02T00:00:00.000Z");
    expect(dueDates.day3DueAt).toBe("2026-01-04T00:00:00.000Z");
    expect(dueDates.day7DueAt).toBe("2026-01-08T00:00:00.000Z");
  });
});

describe("selectDueStep", () => {
  const baseSteps: FollowupStep[] = [
    { key: "day1", dueAt: "2026-01-02T00:00:00.000Z", sentAt: null, template: "day1" },
    { key: "day3", dueAt: "2026-01-04T00:00:00.000Z", sentAt: null, template: "day3" },
    { key: "day7", dueAt: "2026-01-08T00:00:00.000Z", sentAt: null, template: "day7" },
  ];

  it("returns undefined when nothing is due yet", () => {
    const now = new Date("2026-01-01T12:00:00.000Z");
    expect(selectDueStep(baseSteps, now)).toBeUndefined();
  });

  it("returns the day1 step once its due date has passed", () => {
    const now = new Date("2026-01-02T00:00:01.000Z");
    expect(selectDueStep(baseSteps, now)?.key).toBe("day1");
  });

  it("skips a step that was already sent, even if due", () => {
    const steps: FollowupStep[] = [
      { ...baseSteps[0], sentAt: "2026-01-02T00:00:01.000Z" },
      baseSteps[1],
      baseSteps[2],
    ];
    const now = new Date("2026-01-04T00:00:01.000Z");
    expect(selectDueStep(steps, now)?.key).toBe("day3");
  });

  it("returns the earliest due-and-unsent step, not the latest", () => {
    // both day1 and day3 are due by day 5 — day1 (still unsent) must win.
    const now = new Date("2026-01-05T00:00:00.000Z");
    expect(selectDueStep(baseSteps, now)?.key).toBe("day1");
  });

  it("returns undefined once every step has been sent", () => {
    const steps: FollowupStep[] = baseSteps.map((s) => ({ ...s, sentAt: "2026-01-09T00:00:00.000Z" }));
    const now = new Date("2026-02-01T00:00:00.000Z");
    expect(selectDueStep(steps, now)).toBeUndefined();
  });
});
