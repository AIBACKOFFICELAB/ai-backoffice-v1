import Link from "next/link";
import { getUser } from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant";
import { AppNav } from "@/components/AppNav";

const ownerNavItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/lead-inbox", label: "Lead Inbox" },
  { href: "/follow-ups", label: "Follow-Ups" },
  { href: "/review-requests", label: "Review Requests" },
  { href: "/prospects", label: "Prospects" },
  { href: "/settings", label: "Settings" },
];

const staffNavItems = ownerNavItems.filter((item) => item.href !== "/settings");

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  const tenant = user ? await getTenantContext() : null;
  const navItems = tenant?.role === "staff" ? staffNavItems : ownerNavItems;

  return (
    <div className="min-h-screen bg-surface text-ink-900">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-floating"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-surface-border bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-page items-center justify-between gap-3 px-5 sm:px-8">
          <Link href={user ? "/dashboard" : "/"} className="font-display text-[17px] font-bold tracking-tight">
            AI BackOffice
          </Link>

          <AppNav navItems={navItems} userEmail={user?.email ?? null} />
        </div>
      </header>
      <main id="main-content" className="mx-auto max-w-page px-5 py-8 sm:px-8">{children}</main>
    </div>
  );
}
