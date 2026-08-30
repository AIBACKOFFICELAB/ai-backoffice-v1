import {
  LayoutDashboard,
  Inbox,
  Clock,
  Bot,
  Target,
  Star,
  Settings,
  type LucideIcon,
} from "lucide-react";

/**
 * P1B information architecture — organizes EXISTING routes into a
 * stronger structure (P1 directive §13). No links to pages that don't
 * exist; future concepts (Supervisor, Job Notes, Reputation Agent, A/R
 * Agent, Invoice Pilot Pro) are deliberately NOT represented here at all —
 * "prefer omitting them over creating misleading navigation."
 */
export type NavItem = { href: string; label: string; icon: LucideIcon; ownerOnly?: boolean };
export type NavGroup = { label: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Command Center",
    items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Revenue",
    items: [
      { href: "/lead-inbox", label: "Lead Inbox", icon: Inbox },
      { href: "/follow-ups", label: "Follow-Ups", icon: Clock },
    ],
  },
  {
    label: "AI Operations",
    items: [{ href: "/agentic", label: "AI Activity", icon: Bot }],
  },
  {
    label: "Growth",
    items: [
      { href: "/prospects", label: "Prospects", icon: Target },
      { href: "/review-requests", label: "Review Requests", icon: Star },
    ],
  },
  {
    label: "Admin",
    items: [{ href: "/settings", label: "Settings", icon: Settings, ownerOnly: true }],
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
