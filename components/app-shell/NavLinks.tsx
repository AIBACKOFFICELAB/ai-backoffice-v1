"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Inbox, Clock, Bot, Target, Star, Settings, ShieldCheck, Wallet, type LucideIcon } from "lucide-react";
import { NavGroup, NavIconKey, isNavItemActive } from "./navConfig";

/**
 * The nav item list itself — shared, unstyled-at-the-container-level
 * content rendered by both Sidebar.tsx (desktop, always mounted) and
 * MobileNav.tsx (drawer). Active-route highlighting needs usePathname, so
 * this is a client component; the surrounding shell (AppShell.tsx) stays a
 * server component.
 *
 * The actual Lucide icon component references live ONLY here, inside the
 * client boundary — navConfig.ts (imported by the Server Component
 * AppShell.tsx) only ever holds a plain NavIconKey string. Icon components
 * are functions; a function value cannot be serialized across a Server ->
 * Client props boundary, which is exactly what produced production digest
 * 1267400528. Do not move this ICONS map (or any Lucide component
 * reference) back into navConfig.ts.
 */
const ICONS: Record<NavIconKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  inbox: Inbox,
  clock: Clock,
  bot: Bot,
  target: Target,
  star: Star,
  settings: Settings,
  shield: ShieldCheck,
  wallet: Wallet,
};

export function NavLinks({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="px-3 text-xs font-semibold uppercase tracking-wider text-ink-400">{group.label}</p>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = isNavItemActive(pathname, item.href);
              const Icon = ICONS[item.icon];
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-[44px] items-center gap-3 rounded-control px-3 text-[15px] font-medium transition focus-ring ${
                    active ? "bg-brand-50 text-brand-800" : "text-ink-500 hover:bg-surface-sunken hover:text-ink-900"
                  }`}
                >
                  <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
