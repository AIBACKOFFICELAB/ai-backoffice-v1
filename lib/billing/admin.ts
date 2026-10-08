import "server-only";
import { createClient } from "@supabase/supabase-js";

/** Cookie-free service-role client, private to the billing/provisioning
 * adapter (same pattern as lib/leads/intake/server.ts). Never exported to
 * request-scoped application code. */
export function billingAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Billing database unavailable");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(10000) }) },
  });
}
