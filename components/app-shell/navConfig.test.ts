import { describe, it, expect } from "vitest";
import { resolveNavGroups, NAV_GROUPS, isNavItemActive } from "./navConfig";

function flatten(groups: ReturnType<typeof resolveNavGroups>) {
  return groups.flatMap((g) => g.items.map((i) => i.href));
}

describe("resolveNavGroups", () => {
  it("gives the owner every configured nav item, including Settings", () => {
    const hrefs = flatten(resolveNavGroups("owner"));
    expect(hrefs).toContain("/settings");
    expect(hrefs).toContain("/dashboard");
    expect(hrefs).toContain("/lead-inbox");
    expect(hrefs).toContain("/follow-ups");
    expect(hrefs).toContain("/agentic");
    expect(hrefs).toContain("/prospects");
    expect(hrefs).toContain("/review-requests");
  });

  it("never gives staff an owner-only item — Settings does not regress to visible", () => {
    const hrefs = flatten(resolveNavGroups("staff"));
    expect(hrefs).not.toContain("/settings");
  });

  it("gives staff every non-owner-only item", () => {
    const hrefs = flatten(resolveNavGroups("staff"));
    expect(hrefs).toContain("/dashboard");
    expect(hrefs).toContain("/lead-inbox");
    expect(hrefs).toContain("/follow-ups");
    expect(hrefs).toContain("/agentic");
    expect(hrefs).toContain("/prospects");
    expect(hrefs).toContain("/review-requests");
  });

  it("does not link to any route outside the known, existing set (no broken/speculative links)", () => {
    const KNOWN_ROUTES = new Set([
      "/dashboard",
      "/lead-inbox",
      "/follow-ups",
      "/agentic",
      "/prospects",
      "/review-requests",
      "/settings",
    ]);
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        expect(KNOWN_ROUTES.has(item.href)).toBe(true);
      }
    }
  });

  it("drops a group entirely if role-filtering leaves it empty, rather than rendering an empty heading", () => {
    for (const group of resolveNavGroups("staff")) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });
});

describe("isNavItemActive", () => {
  it("is active on an exact route match", () => {
    expect(isNavItemActive("/dashboard", "/dashboard")).toBe(true);
  });

  it("is active on a nested sub-route", () => {
    expect(isNavItemActive("/leads/abc123", "/leads")).toBe(true);
  });

  it("is not active for an unrelated route", () => {
    expect(isNavItemActive("/settings", "/dashboard")).toBe(false);
  });

  it("is not active for a route that merely shares a text prefix without a path boundary", () => {
    // /lead-inbox must not be considered active for the /leads nav item.
    expect(isNavItemActive("/lead-inbox", "/leads")).toBe(false);
  });

  it("is never active when pathname is not yet known (null/undefined)", () => {
    expect(isNavItemActive(null, "/dashboard")).toBe(false);
    expect(isNavItemActive(undefined, "/dashboard")).toBe(false);
  });
});
