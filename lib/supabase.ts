/**
 * @deprecated
 * This file has been split into separate files:
 * - lib/supabase/client.ts - for client-side use
 * - lib/supabase/server.ts - for server-side use
 * 
 * Please import from the specific files instead.
 */

// Re-export for backward compatibility (if needed)
export { createClient } from "./supabase/client";
export { createServerSupabaseClient } from "./supabase/server";

