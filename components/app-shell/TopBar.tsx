import Link from "next/link";
import { LogOut } from "lucide-react";

/**
 * Desktop top utility bar (P1 directive §12) — sits above the main
 * workspace, to the right of the persistent sidebar. Account-level
 * utility only; page titles/actions live in each page's own PageHeader,
 * not duplicated here.
 */
export function TopBar({ tenantName, userEmail }: { tenantName: string; userEmail: string | null }) {
  return (
    <header className="sticky top-0 z-20 hidden h-16 shrink-0 items-center justify-between border-b border-surface-border bg-white/90 px-8 backdrop-blur lg:flex">
      <p className="text-sm font-semibold text-ink-900">{tenantName}</p>
      <div className="flex items-center gap-3">
        {userEmail && <span className="max-w-[220px] truncate text-sm text-ink-500">{userEmail}</span>}
        <Link
          href="/auth/logout"
          className="flex items-center gap-1.5 rounded-control bg-surface-sunken px-3.5 py-2 text-sm font-medium text-ink-700 transition hover:bg-danger-50 hover:text-danger-700 focus-ring"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Sign out
        </Link>
      </div>
    </header>
  );
}
