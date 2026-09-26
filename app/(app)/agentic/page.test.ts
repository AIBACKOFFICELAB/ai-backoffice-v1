import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * P1 Sprint 7 §9/§18 — source-scan regression proof for the AI Activity
 * page's active-vs-historical incident presentation, same discipline as
 * lib/format/timestampUsage.test.ts.
 */

const PAGE = join(__dirname, "page.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(): string {
  return stripComments(readFileSync(PAGE, "utf8"));
}

describe("AI Activity page — P1 Sprint 7 active/historical incident regression pins", () => {
  it("classifies agent run failures via the shared incident classifier, never a raw status-only filter for the attention alert", () => {
    const source = readSource();
    expect(source).toMatch(/from\s+["']@\/lib\/agents\/operationalIncidents["']/);
    expect(source).toMatch(/classifyAgentRunIncidents\s*\(\s*agentRuns\s*\)/);
  });

  it("the Estimate Closing failure alert is gated on the ACTIVE subset, not the raw historical total", () => {
    const source = readSource();
    expect(source).toMatch(/estimateClosingActiveFailures\.length > 0/);
    expect(source).not.toMatch(/\{estimateClosingFailures\.length > 0 &&/);
  });

  it("shows a calm historical note distinct from the warning alert once every failure is resolved", () => {
    const source = readSource();
    expect(source).toContain("Historical failure — resolved by a later successful run");
  });

  it("marks a resolved failed run 'Historical' in the Recent agent runs list without deleting or mutating it", () => {
    const source = readSource();
    expect(source).toMatch(/isHistoricalFailure/);
    expect(source).toContain("Historical");
    // Never a delete/mutation call anywhere near the run list.
    expect(source).not.toMatch(/\.(delete|remove)\s*\(\s*run\.id/);
  });
});
