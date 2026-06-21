import Link from "next/link";
import { getUser } from "@/lib/auth";

const navItems = [
  { href: "/", label: "Home" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/lead-inbox", label: "Lead Inbox" },
  { href: "/follow-ups", label: "Follow-Ups" },
  { href: "/review-requests", label: "Review Requests" },
  { href: "/pricing", label: "Pricing" },
  { href: "/settings", label: "Settings" },
];

const protectedNavItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/lead-inbox", label: "Lead Inbox" },
  { href: "/follow-ups", label: "Follow-Ups" },
  { href: "/review-requests", label: "Review Requests" },
  { href: "/settings", label: "Settings" },
];

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  
  // Use protected nav items if user is authenticated, otherwise show all items
  const displayNavItems = user ? protectedNavItems : navItems;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <Link href="/" className="text-lg font-bold">AI BackOffice</Link>
          <nav className="flex flex-wrap gap-2 text-sm">
            {displayNavItems.map((item) => (
              <Link key={item.href} href={item.href} className="rounded-full px-3 py-1.5 font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900">
                {item.label}
              </Link>
            ))}
          </nav>
          {user && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-slate-600">{user.email}</span>
              <Link href="/auth/logout" className="rounded-full bg-slate-100 px-3 py-1.5 font-medium text-slate-700 transition hover:bg-red-100 hover:text-red-700">
                Sign Out
              </Link>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
