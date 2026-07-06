import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * TEMPORARY diagnostic endpoint for the Founder Deployment login
 * investigation. Returns only booleans, structured (non-secret) error
 * fields, and the Supabase project ref parsed from the public URL — never
 * a key value, token, or password. Hardcoded to the known founder email
 * only, so this cannot be used as a general email-existence oracle.
 *
 * Uses a plain service-role `createClient` (not the @supabase/ssr
 * cookie-bound client from lib/supabase/server.ts) because the Admin API
 * (`auth.admin.*`) is a service-role-only surface unrelated to user
 * sessions/cookies — the ssr client is the wrong tool for this check.
 *
 * DELETE THIS ROUTE once the login issue is resolved — it is not part of
 * the permanent module architecture (docs/constitution/03_MODULE_ARCHITECTURE.md)
 * and should not ship long-term.
 */
const FOUNDER_EMAIL = "5starplumbing05@gmail.com";

type SafeError = {
  name: string | null;
  message: string | null;
  code: string | null;
  details: string | null;
  hint: string | null;
} | null;

function toSafeError(err: unknown): SafeError {
  if (!err) return null;
  const e = err as Record<string, unknown>;
  return {
    name: typeof e.name === "string" ? e.name : null,
    message: typeof e.message === "string" ? e.message : null,
    code: typeof e.code === "string" ? e.code : null,
    details: typeof e.details === "string" ? e.details : null,
    hint: typeof e.hint === "string" ? e.hint : null,
  };
}

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
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hasSupabaseUrl = Boolean(supabaseUrl);
  const hasAnonKey = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const hasServiceRole = Boolean(serviceRoleKey);
  const supabaseProjectRef = extractProjectRef(supabaseUrl);

  let authUserExists = false;
  let tenantMembershipExists = false;
  let dbCheckError: SafeError = null;

  if (hasSupabaseUrl && hasServiceRole) {
    try {
      const adminClient = createClient(supabaseUrl!, serviceRoleKey!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data: authData, error: authErr } = await adminClient.auth.admin.listUsers();

      if (authErr) {
        dbCheckError = toSafeError(authErr);
      } else {
        const founder = authData.users.find((u) => u.email === FOUNDER_EMAIL);
        authUserExists = Boolean(founder);

        if (founder) {
          const { data: membership, error: membershipErr } = await adminClient
            .from("tenant_memberships")
            .select("id")
            .eq("user_id", founder.id)
            .maybeSingle();

          if (membershipErr) {
            dbCheckError = toSafeError(membershipErr);
          } else {
            tenantMembershipExists = Boolean(membership);
          }
        }
      }
    } catch (error) {
      dbCheckError = toSafeError(error) ?? { name: "UnknownError", message: String(error), code: null, details: null, hint: null };
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
