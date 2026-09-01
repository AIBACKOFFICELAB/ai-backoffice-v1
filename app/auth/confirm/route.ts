import { NextRequest, NextResponse } from "next/server";
import { createServerRecoveryDeps, handleRecoveryConfirm } from "@/lib/auth/recoveryConfirmRoute";

/**
 * SSR token-hash password-recovery confirmation — the canonical destination
 * for password-reset emails going forward (see AUTH_SETUP.md for the exact
 * required Supabase email-template change and the production incident this
 * route fixes). Verifies `token_hash` via supabase.auth.verifyOtp({ type:
 * "recovery" }) — no PKCE code_verifier, so it works the same regardless of
 * which production hostname the browser is on when the link is clicked.
 *
 * All logic lives in lib/auth/recoveryConfirmRoute.ts /
 * lib/auth/recoveryConfirm.ts, which are unit-tested directly; this file is
 * intentionally a thin passthrough, matching this repo's existing
 * app/api/.../route.ts convention (see e.g.
 * app/api/agents/estimate-closing/recommendations/[eventId]/review/route.ts).
 *
 * app/auth/callback/route.ts (the PKCE code-exchange flow) is left in place
 * untouched — this route does not replace it, it adds a hostname-independent
 * path for password recovery specifically.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleRecoveryConfirm(request, createServerRecoveryDeps());
}
