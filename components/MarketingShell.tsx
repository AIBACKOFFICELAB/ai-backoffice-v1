"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { AUDIT_URL } from "@/lib/constants";

const navItems = [
  { href: "/pricing", label: "Pricing" },
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#faq", label: "FAQ" },
];

export function MarketingShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen bg-surface text-ink-900">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-floating"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-surface-border bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-page items-center justify-between px-5 sm:px-8">
          <Link href="/" className="font-display text-[17px] font-bold tracking-tight text-ink-900">
            AI BackOffice
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-control px-3.5 py-2 text-sm font-medium text-ink-500 transition hover:bg-surface-sunken hover:text-ink-900"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            <Link
              href="/auth/login"
              className="rounded-control px-3.5 py-2 text-sm font-semibold text-ink-700 transition hover:bg-surface-sunken"
            >
              Log in
            </Link>
            <Button href={AUDIT_URL} target="_blank" rel="noopener noreferrer" size="sm">
              Get My Free Audit
            </Button>
          </div>

          <button
            type="button"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
            className="flex h-11 w-11 items-center justify-center rounded-control text-ink-700 focus-ring md:hidden"
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
        </div>

        {open && (
          <nav id="mobile-nav" className="border-t border-surface-border bg-white px-5 py-3 md:hidden">
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
              <Link
                href="/auth/login"
                onClick={() => setOpen(false)}
                className="flex min-h-[44px] items-center rounded-control px-3 text-[15px] font-medium text-ink-700 hover:bg-surface-sunken"
              >
                Log in
              </Link>
            </div>
            <Button
              href={AUDIT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 w-full"
              onClick={() => setOpen(false)}
            >
              Get My Free Audit
            </Button>
          </nav>
        )}
      </header>

      <main id="main-content">{children}</main>

      <footer className="border-t border-surface-border bg-white">
        <div className="mx-auto max-w-page px-5 py-12 sm:px-8">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="font-display text-[16px] font-bold text-ink-900">AI BackOffice</p>
              <p className="mt-2 max-w-xs text-sm text-ink-500">
                The automated front office for home service contractors — missed-call recovery, estimate follow-up, and review requests.
              </p>
            </div>
            <div className="flex gap-12 text-sm">
              <div>
                <p className="font-semibold text-ink-900">Product</p>
                <ul className="mt-3 space-y-2 text-ink-500">
                  <li><Link href="/pricing" className="hover:text-ink-900">Pricing</Link></li>
                  <li><Link href="/#how-it-works" className="hover:text-ink-900">How it works</Link></li>
                  <li><Link href="/#faq" className="hover:text-ink-900">FAQ</Link></li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-ink-900">Account</p>
                <ul className="mt-3 space-y-2 text-ink-500">
                  <li><Link href="/auth/login" className="hover:text-ink-900">Log in</Link></li>
                  <li>
                    <a href={AUDIT_URL} target="_blank" rel="noopener noreferrer" className="hover:text-ink-900">
                      Book a free audit
                    </a>
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <p className="mt-10 text-xs text-ink-400">© {new Date().getFullYear()} AI BackOffice. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
