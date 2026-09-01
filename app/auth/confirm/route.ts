import { NextRequest, NextResponse } from "next/server";
import { createServerRecoveryDeps, handleRecoveryConfirmView, handleRecoveryConfirmSubmit } from "@/lib/auth/recoveryConfirmRoute";

/**
 * SSR token-hash password-recovery confirmation — the canonical destination
 * for password-reset emails going forward (see AUTH_SETUP.md for the exact
 * required Supabase email-template change and the production incident this
 * route fixes). Verifies `token_hash` via supabase.auth.verifyOtp({ type:
 * "recovery" }) — no PKCE code_verifier, so it works the same regardless of
 * which production hostname the browser is on when the link is clicked.
 *
 * Split across two methods deliberately: GET only renders a confirmation
 * interstitial (safe to prefetch/scan — see handleRecoveryConfirmView's own
 * doc comment for why); POST performs the actual, one-time-token-consuming
 * verification, reached only via that interstitial's own form submit.
 *
 * All logic lives in lib/auth/recoveryConfirmRoute.ts /
 * lib/auth/recoveryConfirm.ts, which are unit-tested directly; this file is
 * intentionally a thin passthrough, matching this repo's existing
 * app/api/.../route.ts convention.
 *
 * app/auth/callback/route.ts (the PKCE code-exchange flow) is left in place
 * untouched — this route does not replace it, it adds a hostname-independent
 * path for password recovery specifically.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleRecoveryConfirmView(request);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleRecoveryConfirmSubmit(request, createServerRecoveryDeps());
}
