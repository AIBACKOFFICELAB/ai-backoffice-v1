import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * P1 Sprint 7 §16/§18/§20 — source-scan regression proof for the Estimate
 * Closing workspace, same discipline as lib/format/timestampUsage.test.ts.
 */

const PAGE = join(__dirname, "page.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(): string {
  return stripComments(readFileSync(PAGE, "utf8"));
}

describe("Estimate Closing workspace — P1 Sprint 7 regression pins", () => {
  it("surfaces 'Already analyzed' (alreadyProcessed) so idempotent zero-new-success scans read as healthy, not failed (§16)", () => {
    const source = readSource();
    expect(source).toContain("Already analyzed");
    expect(source).toMatch(/operations\.latestScanCounts\?\.alreadyProcessed/);
  });

  it("gates the failure alert on activeModelFailureCount, never the raw historical total (§9/§18)", () => {
    const source = readSource();
    expect(source).toMatch(/evaluation\.activeModelFailureCount\s*>\s*0/);
    expect(source).not.toMatch(/\{evaluation\.modelFailureCount > 0 &&/);
  });

  it("shows a calm historical note (not a warning) once every failure has been resolved by a later success (§18)", () => {
    const source = readSource();
    expect(source).toContain("Historical failure — resolved by a later successful run");
  });

  it("drives the Model/run failures metric's warning tone off the active count, not the historical total", () => {
    const source = readSource();
    expect(source).toMatch(/tone=\{operations\.activeModelFailureCount > 0 \? "warning" : "default"\}/);
    expect(source).toMatch(/tone=\{evaluation\.activeModelFailureCount > 0 \? "warning" : "default"\}/);
  });

  it("never passes evaluation.latestRecommendationAt raw into visible text", () => {
    const source = readSource();
    expect(source).not.toMatch(/\{evaluation\.latestRecommendationAt\s*\?\?\s*"—"\}/);
    expect(source).toMatch(/formatOperationalTimestamp\s*\(\s*evaluation\.latestRecommendationAt\s*\)/);
  });
});
