import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { resolveNextPath } from "./passwordRecovery";
import { RECOVERY_OTP_TYPE, isValidRecoveryConfirmRequest, buildRecoveryErrorUrl } from "./recoveryConfirm";

export type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };

export interface RecoveryVerificationResult {
  error: { name?: string; status?: number } | null;
}

export interface RecoveryConfirmDeps {
  /**
   * Verifies a recovery token_hash server-side. `cookieAdapter` mirrors the
   * @supabase/ssr getAll/setAll contract already used by
   * app/auth/callback/route.ts and middleware.ts — the real implementation
   * calls setAll with whatever fresh session cookies verifyOtp produces;
   * handleRecoveryConfirm attaches them to the eventual redirect response
   * so the browser is authenticated on its very next request, no separate
   * round trip needed.
   */
  verifyRecoveryOtp(
    tokenHash: string,
    cookieAdapter: {
      getAll(): Array<{ name: string; value: string }>;
      setAll(cookiesToSet: CookieToSet[]): void;
    }
  ): Promise<RecoveryVerificationResult>;
}

/**
 * The real implementation used by app/auth/confirm/route.ts — a thin
 * wrapper around createServerClient + auth.verifyOtp, adapted to the
 * RecoveryConfirmDeps shape above so handleRecoveryConfirm itself never
 * imports @supabase/ssr directly and stays fully unit-testable with a fake
 * deps object (see recoveryConfirmRoute.test.ts).
 *
 * Fails closed on missing Supabase configuration: returns a deps object
 * whose verifyRecoveryOtp immediately reports an error without attempting
 * any network call, so a misconfigured deployment lands on the same safe
 * recovery-error redirect as an actual verifyOtp failure — never a crash,
 * never a silent false success. Mirrors middleware.ts's fail-closed posture
 * for the same missing-env-var case.
 */
export function createServerRecoveryDeps(): RecoveryConfirmDeps {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.error(
      "[auth/confirm] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY for this environment."
    );
    return {
      async verifyRecoveryOtp() {
        return { error: { name: "config" } };
      },
    };
  }

  return {
    async verifyRecoveryOtp(tokenHash, cookieAdapter) {
      const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          getAll: cookieAdapter.getAll,
          setAll: cookieAdapter.setAll,
        },
      });
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: RECOVERY_OTP_TYPE });
      return { error: error ? { name: error.name, status: error.status } : null };
    },
  };
}

/**
 * Framework-agnostic core of /auth/confirm — the SSR token-hash recovery
 * endpoint. Unlike app/auth/callback/route.ts's exchangeCodeForSession
 * (PKCE), verifyRecoveryOtp needs no browser-held secret — only the
 * token_hash carried in the URL itself — so this endpoint's success does
 * not depend on which hostname (aibackoffice.app, www.aibackoffice.app,
 * ai-backoffice-v1.vercel.app) the browser happens to be on, nor on the
 * click happening in the same browser/device that requested the reset. See
 * lib/auth/recoveryConfirm.ts and AUTH_SETUP.md.
 *
 * `next` is resolved through passwordRecovery.ts's existing resolveNextPath
 * allow-list — the SAME one app/auth/callback/route.ts already uses — so
 * this route inherits the exact same open-redirect protection rather than a
 * parallel, possibly-divergent one.
 */
export async function handleRecoveryConfirm(request: NextRequest, deps: RecoveryConfirmDeps): Promise<NextResponse> {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = resolveNextPath(searchParams.get("next"));

  if (!isValidRecoveryConfirmRequest(tokenHash, type)) {
    return errorRedirect(origin);
  }

  const response = NextResponse.redirect(new URL(next, origin));
  response.headers.set("Cache-Control", "private, no-store");

  const { error } = await deps.verifyRecoveryOtp(tokenHash, {
    getAll: () => request.cookies.getAll(),
    setAll: (cookiesToSet) => cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options)),
  });

  if (error) {
    // Metadata only — never the token_hash, never a raw Supabase error message.
    console.error("[auth/confirm] verifyRecoveryOtp failed:", error.name, error.status);
    return errorRedirect(origin);
  }

  return response;
}

function errorRedirect(origin: string): NextResponse {
  const response = NextResponse.redirect(buildRecoveryErrorUrl(origin));
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
