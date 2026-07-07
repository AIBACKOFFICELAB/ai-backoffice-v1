"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

type NavItem = { href: string; label: string };

export function AppNav({ navItems, userEmail }: { navItems: NavItem[]; userEmail: string | null }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <>
      <nav className="hidden items-center gap-1 lg:flex">
        {navItems.map((item) => {
          const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-control px-3.5 py-2 text-sm font-medium transition ${
                active ? "bg-brand-50 text-brand-800" : "text-ink-500 hover:bg-surface-sunken hover:text-ink-900"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="hidden items-center gap-3 lg:flex">
        {userEmail && <span className="max-w-[180px] truncate text-sm text-ink-500">{userEmail}</span>}
        <Link
          href="/auth/logout"
          className="rounded-control bg-surface-sunken px-3.5 py-2 text-sm font-medium text-ink-700 transition hover:bg-red-50 hover:text-red-700"
        >
          Sign out
        </Link>
      </div>

      <button
        type="button"
        aria-expanded={open}
        aria-controls="app-mobile-nav"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-11 items-center justify-center rounded-control text-ink-700 focus-ring lg:hidden"
      >
        {open ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
      </button>

      {open && (
        <nav
          id="app-mobile-nav"
          className="absolute inset-x-0 top-16 z-30 border-t border-surface-border bg-white px-5 py-3 shadow-raised lg:hidden"
        >
          <div className="flex flex-col">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="flex min-h-[44px] items-center rounded-control px-3 text-[15px] font-medium text-ink-700 hover:bg-surface-sunken"
              >
                {item.label}
              </Link>
            ))}
          </div>
          <div className="mt-2 border-t border-surface-border pt-2">
            {userEmail && <p className="px-3 py-1 text-xs text-ink-400">{userEmail}</p>}
            <Link
              href="/auth/logout"
              onClick={() => setOpen(false)}
              className="flex min-h-[44px] items-center rounded-control px-3 text-[15px] font-medium text-red-700"
            >
              Sign out
            </Link>
          </div>
        </nav>
      )}
    </>
  );
}
