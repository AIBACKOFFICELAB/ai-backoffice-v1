import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricCard } from "./MetricCard";

/**
 * P1 Sprint 6 visual acceptance hotfix — proves MetricCard's new optional
 * `valueTitle` (an accessible tooltip carrying the exact raw instant behind
 * a formatted display value, e.g. "Last durable scan") and the truncation
 * safeguard behave correctly, without changing any existing caller's
 * rendered output. Rendered via renderToStaticMarkup, the same
 * no-component-library pattern ApprovalReadinessEvidence.test.ts already
 * established for this repo.
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

  it("applies a truncation class to the value so an unexpectedly long value degrades to ellipsis, never a multiline wrap that could overlap a neighboring card", () => {
    const html = renderToStaticMarkup(createElement(MetricCard, { label: "Last durable scan", value: "Sep 3, 2026 · 11:11 AM UTC" }));
    expect(html).toContain("truncate");
  });

  it("still renders a plain numeric value exactly as before (regression: existing zero-state cards)", () => {
    const html = renderToStaticMarkup(createElement(MetricCard, { label: "Customer actions taken", value: 0, helpText: "Always 0 in Shadow Mode" }));
    expect(html).toContain(">0<");
    expect(html).toContain("Always 0 in Shadow Mode");
  });
});
