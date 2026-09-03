import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricCard } from "./MetricCard";
import { formatOperationalTimestamp } from "@/lib/format/timestamp";

/**
 * P1 Sprint 6 visual acceptance hotfix — proves MetricCard's new optional
 * `valueTitle` (an accessible tooltip carrying the exact raw instant behind
 * a formatted display value, e.g. "Last durable scan") and `truncateValue`
 * (P1 Sprint 6 FINAL UI HARDENING, PR #26 — a Codex P2 finding: the
 * original hotfix applied `truncate` to EVERY MetricCard unconditionally,
 * silently ellipsizing unrelated long values — e.g. normal business text
 * like "Not enough evidence yet" — with no accessible full value.
 * Truncation is now strictly opt-in, defaulting to `false`) behave
 * correctly, without changing any existing caller's rendered output.
 * Rendered via renderToStaticMarkup, the same no-component-library pattern
 * ApprovalReadinessEvidence.test.ts already established for this repo.
 */
describe("MetricCard", () => {
  it("renders a formatted display value, never a raw long ISO string, as the visible headline text", () => {
    const html = renderToStaticMarkup(
      createElement(MetricCard, { label: "Last durable scan", value: "Sep 3, 2026 · 11:11 AM UTC", valueTitle: "2026-09-03T11:11:54.002556+00:00" })
    );
    expect(html).toContain("Sep 3, 2026 · 11:11 AM UTC");
    // The raw instant may legitimately appear inside the accessible
    // title="..." tooltip attribute (asserted separately below) — strip
    // that attribute out first so this assertion targets only the VISIBLE
    // text content, matching the directive's own distinction between "the
    // headline value" and "accessible secondary text".
    const withoutTitleAttribute = html.replace(/\stitle="[^"]*"/g, "");
    expect(withoutTitleAttribute).not.toContain("2026-09-03T11:11:54.002556+00:00");
  });

  it("carries the exact raw instant as an accessible title attribute on the value", () => {
    const html = renderToStaticMarkup(
      createElement(MetricCard, { label: "Last durable scan", value: "Sep 3, 2026 · 11:11 AM UTC", valueTitle: "2026-09-03T11:11:54.002556+00:00" })
    );
    expect(html).toContain('title="2026-09-03T11:11:54.002556+00:00"');
  });

  it("omits the title attribute entirely when valueTitle is not given — unchanged behavior for every existing caller", () => {
    const html = renderToStaticMarkup(createElement(MetricCard, { label: "Recommendations awaiting review", value: 0 }));
    expect(html).not.toContain("title=");
  });

  it("does NOT truncate by default — truncation is opt-in, never applied merely because a value renders inside a MetricCard", () => {
    const html = renderToStaticMarkup(createElement(MetricCard, { label: "Last durable scan", value: "Sep 3, 2026 · 11:11 AM UTC" }));
    expect(html).not.toContain("truncate");
  });

  it("truncateValue=true adds the truncation class", () => {
    const html = renderToStaticMarkup(createElement(MetricCard, { label: "Last durable scan", value: "Sep 3, 2026 · 11:11 AM UTC", truncateValue: true }));
    expect(html).toContain("truncate");
  });

  it("normal business text (e.g. 'Not enough evidence yet') remains fully readable and untruncated by default", () => {
    const html = renderToStaticMarkup(createElement(MetricCard, { label: "Agreement rate", value: "Not enough evidence yet" }));
    expect(html).toContain("Not enough evidence yet");
    expect(html).not.toContain("truncate");
  });

  it("still renders a plain numeric value exactly as before (regression: existing zero-state cards)", () => {
    const html = renderToStaticMarkup(createElement(MetricCard, { label: "Customer actions taken", value: 0, helpText: "Always 0 in Shadow Mode" }));
    expect(html).toContain(">0<");
    expect(html).toContain("Always 0 in Shadow Mode");
    expect(html).not.toContain("truncate");
  });
});

/**
 * P1 Sprint 6 FINAL UI HARDENING (PR #26) — end-to-end proof for the
 * "Latest recommendation" card specifically (the raw operational
 * timestamp the Codex P2 finding caught left unformatted), combining the
 * real formatOperationalTimestamp with the real MetricCard exactly as
 * app/(app)/agentic/page.tsx does.
 */
describe("MetricCard + formatOperationalTimestamp — 'Latest recommendation' card", () => {
  function renderLatestRecommendationCard(latestRecommendationAt: string | null) {
    const formatted = formatOperationalTimestamp(latestRecommendationAt);
    return renderToStaticMarkup(
      createElement(MetricCard, {
        label: "Latest recommendation",
        value: formatted?.display ?? "—",
        valueTitle: formatted?.title,
        truncateValue: true,
      })
    );
  }

  it("never renders the raw ISO instant as visible headline text", () => {
    const html = renderLatestRecommendationCard("2026-09-03T11:11:54.002556+00:00");
    const withoutTitleAttribute = html.replace(/\stitle="[^"]*"/g, "");
    expect(withoutTitleAttribute).not.toContain("2026-09-03T11:11:54.002556+00:00");
    expect(html).toContain("Sep 3, 2026 · 11:11 AM UTC");
  });

  it("formats deterministically for the same instant", () => {
    const a = renderLatestRecommendationCard("2026-09-03T11:11:54.002556+00:00");
    const b = renderLatestRecommendationCard("2026-09-03T11:11:54.002556+00:00");
    expect(a).toBe(b);
  });

  it("keeps the raw instant available as the accessible title attribute", () => {
    const html = renderLatestRecommendationCard("2026-09-03T11:11:54.002556+00:00");
    expect(html).toContain('title="2026-09-03T11:11:54.002556+00:00"');
  });

  it("renders a truthful em dash — never a fabricated date — when there is no recommendation yet", () => {
    const html = renderLatestRecommendationCard(null);
    expect(html).toContain(">—<");
    expect(html).not.toContain("title=");
  });
});
