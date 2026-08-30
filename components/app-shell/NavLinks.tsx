"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NavGroup, isNavItemActive } from "./navConfig";

/**
 * The nav item list itself — shared, unstyled-at-the-container-level
 * content rendered by both Sidebar.tsx (desktop, always mounted) and
 * MobileNav.tsx (drawer). Active-route highlighting needs usePathname, so
 * this is a client component; the surrounding shell (AppShell.tsx) stays a
 * server component.
 */
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
              const Icon = item.icon;
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
