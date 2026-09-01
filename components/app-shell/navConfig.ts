/**
 * P1B information architecture — organizes EXISTING routes into a
 * stronger structure (P1 directive §13). No links to pages that don't
 * exist; future concepts (Supervisor, Job Notes, Reputation Agent, A/R
 * Agent, Invoice Pilot Pro) are deliberately NOT represented here at all —
 * "prefer omitting them over creating misleading navigation."
 *
 * Production hotfix (digest 1267400528): this module is imported by
 * AppShell.tsx, a Server Component, and NAV_GROUPS crosses the RSC
 * Server -> Client boundary twice (AppShell -> MobileNav directly, and
 * Sidebar -> NavLinks) on every authenticated route. It previously held
 * actual Lucide React component/function values in `icon` — functions are
 * not serializable across that boundary, so every server render of the
 * shared shell threw "Functions cannot be passed directly to Client
 * Components..." and surfaced as a generic server-side exception on every
 * protected page. `icon` is now a plain string key (NavIconKey);
 * NavLinks.tsx (a Client Component) owns the actual icon-key -> Lucide
 * component lookup, entirely on the client side, where component
 * references never need to cross a serialization boundary. See
 * navConfig.test.ts's "Server -> Client boundary serializability" suite,
 * which asserts recursively that NAV_GROUPS/resolveNavGroups() output
 * contains no function values.
 */
export type NavIconKey = "dashboard" | "inbox" | "clock" | "bot" | "target" | "star" | "settings" | "shield" | "wallet";

export type NavItem = { href: string; label: string; icon: NavIconKey; ownerOnly?: boolean };
export type NavGroup = { label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Command Center",
    items: [{ href: "/dashboard", label: "Dashboard", icon: "dashboard" }],
  },
  {
    label: "Revenue",
    items: [
      { href: "/lead-inbox", label: "Lead Inbox", icon: "inbox" },
      { href: "/estimates", label: "Estimates", icon: "wallet" },
      { href: "/follow-ups", label: "Follow-Ups", icon: "clock" },
    ],
  },
  {
    label: "AI Operations",
    items: [
      { href: "/agentic", label: "AI Activity", icon: "bot" },
      { href: "/approvals", label: "Approvals", icon: "shield" },
    ],
  },
  {
    label: "Growth",
    items: [
      { href: "/prospects", label: "Prospects", icon: "target" },
      { href: "/review-requests", label: "Review Requests", icon: "star" },
    ],
  },
  {
    label: "Admin",
    items: [{ href: "/settings", label: "Settings", icon: "settings", ownerOnly: true }],
  },
];

/** Whether a nav item should render as the active route — exact match, or
 * a nested route under it (e.g. /leads/abc123 should not itself appear in
 * the nav, but nothing here currently nests under a top-level item this
 * way except via direct sub-paths). Extracted from NavLinks.tsx so the
 * active-state rule itself is unit-testable without rendering. */
export function isNavItemActive(pathname: string | null | undefined, href: string): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Flattens + filters by role — staff never see owner-only items (mirrors
 * the pre-existing staffNavItems filter this replaces), and drops any
 * group left with zero items after filtering rather than rendering an
 * empty section heading. */
export function resolveNavGroups(role: "owner" | "staff"): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.ownerOnly || role === "owner"),
  })).filter((group) => group.items.length > 0);
}
