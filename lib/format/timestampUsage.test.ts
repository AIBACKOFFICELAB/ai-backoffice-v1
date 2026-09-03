import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * P1 Sprint 6 visual acceptance hotfix — source-scan regression proof, the
 * same discipline lib/agents/estimateClosing/authorityFreeze.test.ts
 * already established for this codebase: when there is no runtime harness
 * for a Next.js Server Component page (this repo has none — see
 * vitest.config.ts's own doc comment; app/**\/page.tsx files use
 * next/navigation redirect() and force-dynamic data fetching that a plain
 * Vitest environment cannot execute), pin the fact in the actual SOURCE so
 * a regression is caught even before any runtime behavior changes.
 *
 * Specifically pins: neither Estimate Closing page passes the raw
 * `operations.lastScanAt` read-model field directly into a MetricCard's
 * `value` prop again — both must route it through
 * formatOperationalTimestamp() first. This is the exact defect the
 * founder's visual QA reported (the raw Postgres ISO instant breaking the
 * "Last durable scan" card's compact layout).
 */

const AGENTIC_PAGE = join(__dirname, "..", "..", "app", "(app)", "agentic", "page.tsx");
const ESTIMATE_CLOSING_PAGE = join(__dirname, "..", "..", "app", "(app)", "agentic", "estimate-closing", "page.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSourceWithoutComments(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

describe("P1 Sprint 6 visual acceptance hotfix — 'Last durable scan' presentation regression", () => {
  it("app/(app)/agentic/page.tsx imports and uses formatOperationalTimestamp", () => {
    const source = readSourceWithoutComments(AGENTIC_PAGE);
    expect(source).toMatch(/from\s+["']@\/lib\/format\/timestamp["']/);
    expect(source).toMatch(/formatOperationalTimestamp\s*\(\s*operations\.lastScanAt\s*\)/);
  });

  it("app/(app)/agentic/page.tsx never passes the raw operations.lastScanAt directly as a MetricCard value prop", () => {
    const source = readSourceWithoutComments(AGENTIC_PAGE);
    expect(source).not.toMatch(/value=\{operations\.lastScanAt\b/);
  });

  it("app/(app)/agentic/estimate-closing/page.tsx imports and uses formatOperationalTimestamp", () => {
    const source = readSourceWithoutComments(ESTIMATE_CLOSING_PAGE);
    expect(source).toMatch(/from\s+["']@\/lib\/format\/timestamp["']/);
    expect(source).toMatch(/formatOperationalTimestamp\s*\(\s*operations\.lastScanAt\s*\)/);
  });

  it("app/(app)/agentic/estimate-closing/page.tsx never passes the raw operations.lastScanAt directly as a MetricCard value prop", () => {
    const source = readSourceWithoutComments(ESTIMATE_CLOSING_PAGE);
    expect(source).not.toMatch(/value=\{operations\.lastScanAt\b/);
  });

  it("neither page's hotfix touches scan telemetry, the operations read model's own semantics, or lead/outcome/approval state", () => {
    for (const path of [AGENTIC_PAGE, ESTIMATE_CLOSING_PAGE]) {
      const source = readSourceWithoutComments(path);
      expect(source).not.toMatch(/updateLead\s*\(/);
      expect(source).not.toMatch(/requestApproval\s*\(/);
      expect(source).not.toMatch(/recordOutcome\s*\(/);
      expect(source).not.toMatch(/from\s+["'][^"']*scanTelemetry["']/);
    }
  });

  it("the commercial evidence section still carries its truthful non-attribution disclaimers, never a bare 'AI wins' claim (unchanged by this hotfix)", () => {
    const source = readSourceWithoutComments(ESTIMATE_CLOSING_PAGE);
    // Deliberately does not ban the substring "revenue recovered" outright —
    // the page correctly uses it inside an honest denial ("Not revenue
    // recovered"), which a bare substring ban would false-positive on.
    expect(source.toLowerCase()).not.toMatch(/\bai wins\b/);
    expect(source).toContain("Owner-reported, not AI-attributed revenue");
    expect(source).toContain("Not revenue recovered");
  });
});
