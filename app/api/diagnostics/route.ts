import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * TEMPORARY diagnostic endpoint for the Founder Deployment login
 * investigation. Returns only booleans and the (non-secret) Supabase
 * project ref parsed from the public URL — never a key value, token, or
 * password. Hardcoded to the known founder email only, so this cannot be
 * used as a general email-existence oracle.
 *
 * DELETE THIS ROUTE once the login issue is resolved — it is not part of
 * the permanent module architecture (docs/constitution/03_MODULE_ARCHITECTURE.md)
 * and should not ship long-term.
 */
const FOUNDER_EMAIL = "5starplumbing05@gmail.com";

function extractProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname; // e.g. xxxxx.supabase.co
    return hostname.split(".")[0] || null;
  } catch {
    return "unparseable";
  }
}

export async function GET() {
  const hasSupabaseUrl = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const hasAnonKey = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const supabaseProjectRef = extractProjectRef(process.env.NEXT_PUBLIC_SUPABASE_URL);

  let authUserExists = false;
  let tenantMembershipExists = false;
  let dbCheckError: string | null = null;

  if (hasSupabaseUrl && hasServiceRole) {
    try {
      const supabase = await createServerSupabaseClient();

      const { data: userRow, error: userError } = await supabase
        .from("tenant_memberships")
        .select("tenant_id, user_id")
        .limit(1);
      // tenant_memberships doesn't have email; do a raw auth lookup instead below.
      void userRow;
      void userError;

      const { data: authData, error: authErr } = await supabase.auth.admin.listUsers();
      if (!authErr) {
        const founder = authData.users.find((u) => u.email === FOUNDER_EMAIL);
        authUserExists = Boolean(founder);
        if (founder) {
          const { data: membership } = await supabase
            .from("tenant_memberships")
            .select("id")
            .eq("user_id", founder.id)
            .maybeSingle();
          tenantMembershipExists = Boolean(membership);
        }
      } else {
        dbCheckError = authErr.message;
      }
    } catch (error) {
      dbCheckError = error instanceof Error ? error.message : "unknown-error";
    }
  }

  return NextResponse.json({
    hasSupabaseUrl,
    supabaseProjectRef,
    hasAnonKey,
    hasServiceRole,
    authUserExists,
    tenantMembershipExists,
    dbCheckError,
  });
}
