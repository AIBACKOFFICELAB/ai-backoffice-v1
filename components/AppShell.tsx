import { getUser } from "@/lib/auth";
import { getTenantContext } from "@/lib/tenant";
import { Sidebar } from "@/components/app-shell/Sidebar";
import { TopBar } from "@/components/app-shell/TopBar";
import { MobileNav } from "@/components/app-shell/MobileNav";
import { resolveNavGroups } from "@/components/app-shell/navConfig";

/**
 * P1B premium application shell (P1 directive §12): persistent left
 * sidebar + top utility bar on desktop, compact top bar + navigation
 * drawer on mobile. Replaces the P0 horizontal-nav MVP shell
 * (components/AppNav.tsx, now unused).
 */
export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  const tenant = user ? await getTenantContext() : null;
  const role = tenant?.role ?? "staff";
  const navGroups = resolveNavGroups(role);
  const tenantName = tenant?.tenantName ?? "AI BackOffice";

  return (
    <div className="min-h-screen bg-surface text-ink-900">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:shadow-floating"
      >
        Skip to content
      </a>

      <Sidebar groups={navGroups} tenantName={tenantName} />
      <MobileNav groups={navGroups} tenantName={tenantName} userEmail={user?.email ?? null} />

      <div className="lg:pl-64">
        <TopBar tenantName={tenantName} userEmail={user?.email ?? null} />
        <main id="main-content" className="mx-auto max-w-page px-5 py-8 sm:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
