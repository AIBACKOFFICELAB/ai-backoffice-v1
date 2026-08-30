"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Menu, X, LogOut } from "lucide-react";
import { NavGroup } from "./navConfig";
import { NavLinks } from "./NavLinks";

/**
 * MOBILE: compact top bar + accessible navigation drawer (P1 directive
 * §12, §20). Closes on Escape and on backdrop click, traps no focus
 * beyond what the browser's own tab order already provides within the
 * drawer (a full focus trap is more machinery than this drawer's scope
 * needs — it's a short, single-column link list, not a modal form).
 */
export function MobileNav({ groups, tenantName, userEmail }: { groups: NavGroup[]; tenantName: string; userEmail: string | null }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="lg:hidden">
      <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-surface-border bg-white/90 px-5 backdrop-blur">
        <Link href="/dashboard" className="font-display text-[17px] font-bold tracking-tight text-ink-900 focus-ring rounded-control">
          AI BackOffice
        </Link>
        <button
          type="button"
          aria-expanded={open}
          aria-controls="mobile-nav-drawer"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
          className="flex h-11 w-11 items-center justify-center rounded-control text-ink-700 focus-ring"
        >
          {open ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
        </button>
      </header>

      {open && (
        <div className="fixed inset-0 z-30" role="presentation">
          <button
            type="button"
            aria-label="Close menu"
            tabIndex={-1}
            className="absolute inset-0 bg-ink-900/30"
            onClick={() => setOpen(false)}
          />
          <nav
            id="mobile-nav-drawer"
            aria-label="Main navigation"
            className="absolute inset-y-0 left-0 flex w-[86vw] max-w-xs flex-col overflow-y-auto border-r border-surface-border bg-white px-3 py-5 shadow-floating"
          >
            <p className="px-3 pb-3 text-sm font-semibold text-ink-900">{tenantName}</p>
            <NavLinks groups={groups} onNavigate={() => setOpen(false)} />
            <div className="mt-auto border-t border-surface-border px-3 pt-4">
              {userEmail && <p className="truncate pb-2 text-xs text-ink-400">{userEmail}</p>}
              <Link
                href="/auth/logout"
                onClick={() => setOpen(false)}
                className="flex min-h-[44px] items-center gap-2 rounded-control px-3 text-[15px] font-medium text-danger-700 hover:bg-danger-50"
              >
                <LogOut className="h-[18px] w-[18px]" aria-hidden="true" />
                Sign out
              </Link>
            </div>
          </nav>
        </div>
      )}
    </div>
  );
}
