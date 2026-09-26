import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LifecycleTimeline } from "./LifecycleTimeline";
import type { TimelineStage } from "@/lib/agents/estimateClosing/evidenceTimeline";

/** P1 Sprint 7 §8 — same renderToStaticMarkup pattern as
 * ApprovalModeLadder.test.ts (no new test dependency; see that file's own
 * doc comment). */
describe("LifecycleTimeline", () => {
  const stages: TimelineStage[] = [
    { kind: "lead_received", status: "completed", occurredAt: "2026-09-09T00:00:00.000Z", label: "Lead received", detail: null },
    { kind: "estimate_sent", status: "completed", occurredAt: "2026-09-10T00:00:00.000Z", label: "Estimate sent", detail: null },
    { kind: "day1_followup", status: "pending", occurredAt: null, label: "Day 1 follow-up", detail: null },
    {
      kind: "owner_review_recorded",
      status: "completed",
      occurredAt: "2026-09-24T00:00:00.000Z",
      label: "Owner review",
      detail: "Agree · Intent: Would not act",
    },
  ];

  const html = renderToStaticMarkup(createElement(LifecycleTimeline, { stages }));

  it("renders every stage's label", () => {
    expect(html).toContain("Lead received");
    expect(html).toContain("Estimate sent");
    expect(html).toContain("Day 1 follow-up");
    expect(html).toContain("Owner review");
  });

  it("marks a pending stage with the visible word 'Pending' — never color alone", () => {
    const day1Index = html.indexOf("Day 1 follow-up");
    const afterDay1 = html.slice(day1Index, day1Index + 400);
    expect(afterDay1).toContain("Pending");
  });

  it("shows a human-readable date as the VISIBLE text for a completed stage, not the raw ISO string", () => {
    expect(html).toContain("Sep 9, 2026");
    expect(html).toContain("Sep 10, 2026");
    // The raw ISO instant is only allowed inside a title="..." attribute
    // (accessible detail), never as visible text content.
    expect(html).not.toMatch(/>[^<]*2026-09-09T00:00:00\.000Z[^<]*</);
  });

  it("carries the exact original instant as a title attribute for accessible detail", () => {
    expect(html).toContain('title="2026-09-09T00:00:00.000Z"');
  });

  it("renders stage detail text when present", () => {
    expect(html).toContain("Agree · Intent: Would not act");
  });
});
