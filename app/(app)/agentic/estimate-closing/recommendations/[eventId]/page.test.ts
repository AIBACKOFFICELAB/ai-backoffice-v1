import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * P1 Sprint 7 §8/§14/§15/§19/§20 — source-scan regression proof, the same
 * discipline lib/format/timestampUsage.test.ts already established for
 * this codebase: no runtime harness exists for a Next.js Server Component
 * page, so these facts are pinned in the actual source.
 */

const PAGE = join(__dirname, "page.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(): string {
  return stripComments(readFileSync(PAGE, "utf8"));
}

describe("recommendation evidence page — P1 Sprint 7 regression pins", () => {
  it("renders the canonical lifecycle timeline via the dedicated read model and component", () => {
    const source = readSource();
    expect(source).toMatch(/from\s+["']@\/lib\/agents\/estimateClosing\/evidenceTimeline["']/);
    expect(source).toMatch(/from\s+["']@\/components\/ai\/LifecycleTimeline["']/);
    expect(source).toMatch(/buildEstimateClosingEvidenceTimeline\s*\(\s*evidence\s*\)/);
  });

  it("carries a stable #actual-follow-through anchor for direct deep-linking (§19)", () => {
    const source = readSource();
    expect(source).toMatch(/id="actual-follow-through"/);
  });

  it("never passes sequence.estimateSentAt/day7DueAt/lastReplyAt or stalledEventOccurredAt raw into a <dd> (§20)", () => {
    const source = readSource();
    expect(source).not.toMatch(/\{evidence\.sequence\?\.estimateSentAt\s*\?\?\s*"Unavailable"\}/);
    expect(source).not.toMatch(/\{evidence\.sequence\?\.day7DueAt\s*\?\?\s*"Unavailable"\}/);
    expect(source).toMatch(/formatOperationalTimestamp\s*\(\s*evidence\.sequence\?\.estimateSentAt/);
    expect(source).toMatch(/formatOperationalTimestamp\s*\(\s*evidence\.sequence\?\.day7DueAt/);
    expect(source).toMatch(/formatOperationalTimestamp\s*\(\s*evidence\.sequence\?\.lastReplyAt/);
    expect(source).toMatch(/formatOperationalTimestamp\s*\(\s*evidence\.stalledEventOccurredAt/);
  });

  it("qualifies the business disposition ladder cell as owner-reported, never a bare canonical label (§15)", () => {
    const source = readSource();
    expect(source).toContain("Owner-reported business disposition");
  });

  it("shows intent vs. actual as a neutral comparison, never a contradiction/error framing (§14)", () => {
    const source = readSource();
    expect(source).toMatch(/Intent vs\. actual/);
    expect(source).toMatch(/Would-act intent/);
    expect(source).toMatch(/Actual action/);
    expect(source.toLowerCase()).not.toMatch(/wouldact[\s\S]{0,120}(contradiction|inconsistency|error|mistake)/);
  });

  it("never claims AI-caused revenue or recovered revenue (unchanged constitutional guardrail)", () => {
    const source = readSource();
    expect(source.toLowerCase()).not.toMatch(/\bai (caused|recovered|won)\b/);
  });
});
