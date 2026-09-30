import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * P1 Sprint 7 §20/§22 — source-scan regression proof for the dashboard's
 * timestamp/mobile fixes, same discipline as lib/format/timestampUsage.test.ts.
 */

const PAGE = join(__dirname, "page.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readSource(): string {
  return stripComments(readFileSync(PAGE, "utf8"));
}

describe("Dashboard page — P1 Sprint 7 regression pins", () => {
  it("formats the Recent activity feed's timestamp instead of passing the raw ISO instant", () => {
    const source = readSource();
    expect(source).not.toMatch(/timestamp=\{item\.occurredAt\}/);
    expect(source).toMatch(/formatOperationalTimestamp\s*\(\s*item\.occurredAt\s*\)/);
  });

  it("the Missed Call Recovery mini-stat grid has a mobile breakpoint override, not a fixed 4-column grid at every width", () => {
    const source = readSource();
    expect(source).not.toMatch(/className="mt-3 grid grid-cols-4 gap-3 text-center"/);
    expect(source).toMatch(/grid-cols-2 gap-3 text-center sm:grid-cols-4/);
  });
});
