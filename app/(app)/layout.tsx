import { AppShell } from "@/components/AppShell";

// This layout checks auth state via cookies on every request, so the
// authenticated app must be dynamic. The marketing route group is
// unaffected and can still be statically optimized.
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
