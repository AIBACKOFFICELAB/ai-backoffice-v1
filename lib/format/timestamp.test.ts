import { describe, it, expect } from "vitest";
import { formatOperationalTimestamp } from "./timestamp";

/**
 * P1 Sprint 6 visual acceptance hotfix — proves the formatter that
 * replaced the raw Postgres ISO timestamp
 * ("2026-09-03T11:11:54.002556+00:00") on the "Last durable scan" metric
 * card is deterministic, UTC-anchored (never silently shifted by the
 * server/CI process's own local timezone), and never fabricates a value
 * for a missing/malformed instant.
 */
describe("formatOperationalTimestamp", () => {
  it("formats the exact real-world value from the reported defect deterministically", () => {
    const result = formatOperationalTimestamp("2026-09-03T11:11:54.002556+00:00");
    expect(result).not.toBeNull();
    expect(result!.display).toBe("Sep 3, 2026 · 11:11 AM UTC");
  });

  it("preserves the exact original instant, unmodified, as the tooltip/title value", () => {
    const result = formatOperationalTimestamp("2026-09-03T11:11:54.002556+00:00");
    expect(result!.title).toBe("2026-09-03T11:11:54.002556+00:00");
  });

  it("never renders the raw long ISO string as the display value", () => {
    const result = formatOperationalTimestamp("2026-09-03T11:11:54.002556+00:00");
    expect(result!.display).not.toContain("T11:11:54");
    expect(result!.display).not.toContain("+00:00");
    expect(result!.display.length).toBeLessThan("2026-09-03T11:11:54.002556+00:00".length);
  });

  it("is anchored to UTC, not the host process's local timezone — a near-midnight-UTC instant never shifts to the adjacent calendar day", () => {
    const result = formatOperationalTimestamp("2026-01-01T00:30:00.000Z");
    expect(result!.display).toContain("Jan 1, 2026");
    expect(result!.display).not.toContain("Dec 31");
  });

  it("is deterministic — the same instant always formats identically", () => {
    const a = formatOperationalTimestamp("2026-09-03T11:11:54.002556+00:00");
    const b = formatOperationalTimestamp("2026-09-03T11:11:54.002556+00:00");
    expect(a).toEqual(b);
  });

  it("returns null for a null instant — callers keep their own truthful empty-state copy", () => {
    expect(formatOperationalTimestamp(null)).toBeNull();
  });

  it("returns null for an undefined instant", () => {
    expect(formatOperationalTimestamp(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(formatOperationalTimestamp("")).toBeNull();
  });

  it("returns null for a malformed, unparseable string — never fabricates a placeholder date", () => {
    expect(formatOperationalTimestamp("not-a-timestamp")).toBeNull();
  });

  it("formats a plain midday UTC instant with a two-digit minute", () => {
    const result = formatOperationalTimestamp("2026-03-15T14:05:00.000Z");
    expect(result!.display).toBe("Mar 15, 2026 · 2:05 PM UTC");
  });
});
