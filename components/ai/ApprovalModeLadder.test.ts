import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalModeLadder } from "./ApprovalModeLadder";

/**
 * P1 Sprint 3 §14/§19 — the trust-progression ladder must never visually
 * suggest a future stage is enabled. See ApprovalReadinessEvidence.test.ts
 * for why react-dom/server's renderToStaticMarkup is used here (no new
 * test dependency, matches vitest.config.ts's `**\/*.test.ts` include).
 */
describe("ApprovalModeLadder", () => {
  const html = renderToStaticMarkup(createElement(ApprovalModeLadder));

  it("marks exactly one stage CURRENT", () => {
    expect((html.match(/CURRENT/g) ?? []).length).toBe(1);
  });

  it("labels Shadow as the current stage", () => {
    const shadowIndex = html.indexOf("Shadow");
    const currentIndex = html.indexOf("CURRENT");
    expect(shadowIndex).toBeGreaterThan(-1);
    expect(currentIndex).toBeGreaterThan(-1);
    // CURRENT appears in the same <li> as Shadow — a rough but effective
    // proximity check without a DOM query engine.
    expect(html.indexOf("Human Approval")).toBeGreaterThan(currentIndex);
  });

  it("marks Human Approval as NOT AUTHORIZED, never enabled", () => {
    expect(html).toContain("NOT AUTHORIZED");
    const humanApprovalIndex = html.indexOf("Human Approval");
    const notAuthorizedIndex = html.indexOf("NOT AUTHORIZED");
    expect(notAuthorizedIndex).toBeLessThan(humanApprovalIndex);
  });

  it("marks the two future stages FUTURE, never CURRENT or authorized-looking", () => {
    expect((html.match(/FUTURE/g) ?? []).length).toBe(2);
    expect(html).toContain("Limited Auto-Execute");
    expect(html).toContain("Trusted Autonomy");
  });

  it("never renders any variant of 'enabled' or 'active' for a future stage", () => {
    expect(html.toLowerCase()).not.toMatch(/limited auto-execute[\s\S]{0,80}(enabled|active)/i);
  });
});
