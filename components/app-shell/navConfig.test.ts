import { describe, it, expect } from "vitest";
import { LayoutDashboard } from "lucide-react";
import { resolveNavGroups, NAV_GROUPS, isNavItemActive, NavIconKey } from "./navConfig";

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

/**
 * Production hotfix regression suite (digest 1267400528).
 *
 * AppShell.tsx (a Server Component) imports NAV_GROUPS/resolveNavGroups()
 * from this module and passes the result across the Server -> Client props
 * boundary twice — directly into MobileNav ("use client"), and via
 * Sidebar into NavLinks ("use client"). Before this hotfix, `icon` held an
 * actual Lucide React component (a function) rather than a string, which
 * is not a valid value to serialize across that boundary — every
 * authenticated route crashed with an identical digest because every one
 * of them mounts this same shared shell. These tests assert the exported
 * navigation data can never regress to holding a non-serializable value
 * again, and prove the check itself is real by demonstrating it fails
 * against the exact shape the old, broken code produced.
 */
describe("Server -> Client boundary serializability (production hotfix, digest 1267400528)", () => {
  const APPROVED_ICON_KEYS: ReadonlySet<NavIconKey> = new Set<NavIconKey>([
    "dashboard",
    "inbox",
    "clock",
    "bot",
    "target",
    "star",
    "settings",
  ]);

  /**
   * Mirrors what the real RSC Server -> Client boundary rejects: functions,
   * symbols, bigints, and non-plain object instances (Date/Map/Set/class
   * instances) anywhere in the value, recursively. Deliberately a superset
   * check (stricter than the RSC wire protocol strictly requires — e.g. it
   * would also flag a Promise, which RSC does allow) — sufficient here
   * because NavGroup/NavItem's declared shape is plain
   * strings/booleans/arrays/objects only, so nothing legitimate should
   * ever need one of RSC's special-cased extra types.
   */
  function assertPlainSerializable(value: unknown, path = "root"): void {
    if (value === null || value === undefined) return;
    const t = typeof value;
    if (t === "function") {
      throw new Error(
        `Non-serializable function value at ${path} — would fail the RSC Server -> Client boundary (the exact bug behind production digest 1267400528)`
      );
    }
    if (t === "symbol" || t === "bigint") {
      throw new Error(`Non-serializable ${t} value at ${path}`);
    }
    if (t !== "object") return; // string / number / boolean are fine
    if (value instanceof Date || value instanceof Map || value instanceof Set) {
      throw new Error(`Non-serializable ${value.constructor.name} instance at ${path}`);
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => assertPlainSerializable(v, `${path}[${i}]`));
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`Non-plain object (custom prototype) at ${path}`);
    }
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      assertPlainSerializable(v, `${path}.${key}`);
    }
  }

  it("resolveNavGroups('owner') contains no function/component values anywhere", () => {
    expect(() => assertPlainSerializable(resolveNavGroups("owner"))).not.toThrow();
  });

  it("resolveNavGroups('staff') contains no function/component values anywhere", () => {
    expect(() => assertPlainSerializable(resolveNavGroups("staff"))).not.toThrow();
  });

  it("every icon on every item is one of the approved string keys, for both roles", () => {
    for (const role of ["owner", "staff"] as const) {
      for (const group of resolveNavGroups(role)) {
        for (const item of group.items) {
          expect(typeof item.icon).toBe("string");
          expect(APPROVED_ICON_KEYS.has(item.icon)).toBe(true);
        }
      }
    }
  });

  it("round-trips through JSON without loss, for both roles — a practical proxy for 'this is plain serializable navigation data'", () => {
    for (const role of ["owner", "staff"] as const) {
      const groups = resolveNavGroups(role);
      const roundTripped = JSON.parse(JSON.stringify(groups));
      expect(roundTripped).toEqual(groups);
    }
  });

  it("regression: the checker actually catches the old bug — a component-valued icon fails serializability", () => {
    // Reproduces the exact shape navConfig.ts held before this hotfix:
    // icon: LayoutDashboard, the real Lucide component, not a string key.
    // Proves this suite is not vacuous — it would have failed against the
    // pre-hotfix code, not just against a hypothetical one. Lucide's icons
    // are React.forwardRef components (a plain object carrying a
    // `$$typeof` Symbol and a `render` function), so the checker trips on
    // the Symbol before it reaches the nested function — either way it is
    // caught, and either way it is exactly the class of value the real RSC
    // boundary rejects (React elements/components are not JSON-plain
    // data).
    const brokenGroups = [
      {
        label: "Command Center",
        items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard }],
      },
    ];
    expect(() => assertPlainSerializable(brokenGroups)).toThrow(/Non-serializable (function|symbol)/);
  });
});
