import Link from "next/link";
import { NavGroup } from "./navConfig";
import { NavLinks } from "./NavLinks";

export const SIDEBAR_WIDTH_CLASS = "lg:w-64";

/**
 * Persistent desktop left sidebar (P1 directive §12: "DESKTOP: Persistent
 * left sidebar + top utility/command bar + main workspace"). Hidden below
 * the lg breakpoint — MobileNav.tsx covers narrower widths with a compact
 * top bar + drawer instead.
 */
export function Sidebar({ groups, tenantName }: { groups: NavGroup[]; tenantName: string }) {
  return (
    <aside
      className={`fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-surface-border bg-white lg:flex ${SIDEBAR_WIDTH_CLASS}`}
    >
      <div className="flex h-16 shrink-0 items-center border-b border-surface-border px-5">
        <Link href="/dashboard" className="font-display text-[17px] font-bold tracking-tight text-ink-900 focus-ring rounded-control">
          AI BackOffice
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5">
        <NavLinks groups={groups} />
      </div>
      <div className="shrink-0 border-t border-surface-border px-5 py-4">
        <p className="truncate text-xs font-medium text-ink-400">{tenantName}</p>
      </div>
    </aside>
  );
}
