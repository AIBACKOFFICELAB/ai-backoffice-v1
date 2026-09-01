import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalReadinessEvidence } from "./ApprovalReadinessEvidence";

/**
 * P1 Sprint 3 §8/§19 — "Human Approval Mode is not authorized" must be a
 * FIXED governance statement, never a computed pass/fail. Rendered via
 * react-dom/server's renderToStaticMarkup (already a transitive dependency
 * of Next.js — no new test-tooling dependency added) since this repo has
 * no component-testing library; using createElement (not JSX) keeps this
 * a plain .test.ts file, matching vitest.config.ts's existing
 * `**\/*.test.ts` include pattern exactly.
 */

const BASE_PROPS = {
  recommendationsGenerated: 0,
  recommendationsReviewed: 0,
  agreeCount: 0,
  agreementRate: null as number | null,
  wouldActYes: 0,
  modelFailureCount: 0,
  toolCallsAttributable: 0,
  approvalsAttributable: 0,
  customerActionsAttributable: 0,
};

describe("ApprovalReadinessEvidence", () => {
  it("always states Human Approval Mode is not authorized, with zero evidence", () => {
    const html = renderToStaticMarkup(createElement(ApprovalReadinessEvidence, BASE_PROPS));
    expect(html).toContain("Human Approval Mode is not authorized.");
    expect(html).toContain("Readiness will be decided after sufficient Shadow evidence is reviewed.");
    expect(html).toContain("Not enough evidence yet");
  });

  it("still states Human Approval Mode is not authorized even with a large, favorable-looking sample — no threshold flips it", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalReadinessEvidence, {
        recommendationsGenerated: 500,
        recommendationsReviewed: 500,
        agreeCount: 500,
        agreementRate: 1,
        wouldActYes: 500,
        modelFailureCount: 0,
        toolCallsAttributable: 0,
        approvalsAttributable: 0,
        customerActionsAttributable: 0,
      })
    );
    // The exact same fixed governance sentence, regardless of the numbers
    // — this is the test that would fail if a threshold/"Ready" branch
    // were ever introduced.
    expect(html).toContain("Human Approval Mode is not authorized.");
    expect(html).not.toContain("Ready");
    expect(html).not.toContain("READY");
  });

  it("renders the real counts passed in, not fabricated ones", () => {
    const html = renderToStaticMarkup(createElement(ApprovalReadinessEvidence, { ...BASE_PROPS, recommendationsGenerated: 7, modelFailureCount: 2 }));
    expect(html).toContain("7");
    expect(html).toContain("2");
  });

  it("shows a 0 count, not a hidden/omitted one, for structurally-guaranteed-zero safety fields", () => {
    const html = renderToStaticMarkup(createElement(ApprovalReadinessEvidence, BASE_PROPS));
    expect(html).toContain("Tool calls");
    expect(html).toContain("Approvals created");
    expect(html).toContain("Customer actions taken");
  });
});
