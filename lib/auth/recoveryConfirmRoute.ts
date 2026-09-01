import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { resolveNextPath } from "./passwordRecovery";
import { RECOVERY_OTP_TYPE, isValidRecoveryConfirmRequest, buildRecoveryErrorUrl, escapeHtmlAttribute } from "./recoveryConfirm";

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
   * handleRecoveryConfirmSubmit attaches them to the eventual redirect
   * response so the browser is authenticated on its very next request, no
   * separate round trip needed.
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
 * RecoveryConfirmDeps shape above so the handlers below never import
 * @supabase/ssr directly and stay fully unit-testable with a fake deps
 * object (see recoveryConfirmRoute.test.ts).
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
 * GET /auth/confirm — renders a confirmation interstitial and performs NO
 * Supabase call. This is deliberate: a GET request must be safe (RFC 7231),
 * and this route is reached directly from an emailed link, which email-
 * security scanners and link-preview services routinely fetch via GET
 * before a human ever clicks. An earlier version of this route called
 * verifyOtp directly on GET — a Codex review finding on this same PR caught
 * that a scanner's prefetch would consume the one-time recovery token and
 * establish a session only the scanner ever sees, leaving the real human
 * click to fail as "expired" — reproducing one of the exact production
 * failure modes this hotfix exists to fix (see AUTH_SETUP.md). The
 * state-changing verifyOtp call now happens only in
 * handleRecoveryConfirmSubmit below, reached exclusively via the
 * interstitial's own same-site form POST, which a passive GET
 * scan/prefetch never issues.
 */
export function handleRecoveryConfirmView(request: NextRequest): NextResponse {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = resolveNextPath(searchParams.get("next"));

  if (!isValidRecoveryConfirmRequest(tokenHash, type)) {
    return errorRedirect(origin);
  }

  return new NextResponse(renderConfirmInterstitialHtml(tokenHash, next), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The rendered page embeds the still-live token_hash in a hidden
      // field — it must never be cached/replayed to a different visitor.
      "Cache-Control": "private, no-store",
    },
  });
}

/**
 * POST /auth/confirm — the actual, state-changing recovery verification.
 * Only reached via the interstitial's own form submit (a same-site POST
 * triggered by an explicit click), never by a passive GET prefetch or scan.
 */
export async function handleRecoveryConfirmSubmit(request: NextRequest, deps: RecoveryConfirmDeps): Promise<NextResponse> {
  const origin = request.nextUrl.origin;
  const formData = await request.formData();
  const tokenHashRaw = formData.get("token_hash");
  const nextRaw = formData.get("next");
  const tokenHash = typeof tokenHashRaw === "string" ? tokenHashRaw : null;
  const next = resolveNextPath(typeof nextRaw === "string" ? nextRaw : null);

  // The form never carries a `type` field — this endpoint is recovery-only
  // by construction, so the literal is passed directly rather than trusting
  // any caller-supplied value.
  if (!isValidRecoveryConfirmRequest(tokenHash, RECOVERY_OTP_TYPE)) {
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

/**
 * The confirmation interstitial itself — plain HTML, no client JS, no
 * hydration; the form works with JavaScript disabled. `tokenHash` is
 * attacker/URL-supplied and HTML-escaped before being embedded in the
 * hidden field's value attribute; `next` is never escaped because
 * resolveNextPath already constrains it to one of a small set of fixed
 * literal strings (see passwordRecovery.ts), never free text.
 */
function renderConfirmInterstitialHtml(tokenHash: string, next: string): string {
  const escapedTokenHash = escapeHtmlAttribute(tokenHash);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm password reset — AI BackOffice</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#f7f7f5; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .card { max-width:400px; width:calc(100% - 40px); background:#fff; border-radius:16px; box-shadow:0 1px 3px rgba(0,0,0,0.08); padding:32px; text-align:center; }
  h1 { font-size:22px; margin:0 0 8px; color:#18181b; }
  p { font-size:14px; color:#71717a; margin:0 0 24px; line-height:1.5; }
  button { width:100%; padding:12px; border:0; border-radius:10px; background:#18181b; color:#fff; font-size:14px; font-weight:600; cursor:pointer; }
  button:hover { background:#27272a; }
  .brand { display:block; margin-bottom:24px; font-weight:700; color:#18181b; text-decoration:none; font-size:16px; }
</style>
</head>
<body>
  <div class="card">
    <a class="brand" href="/">AI BackOffice</a>
    <h1>Reset your password</h1>
    <p>Confirm below to continue resetting your password. This extra step keeps your reset link from being used by anything other than you clicking it.</p>
    <form method="POST" action="/auth/confirm">
      <input type="hidden" name="token_hash" value="${escapedTokenHash}">
      <input type="hidden" name="next" value="${next}">
      <button type="submit">Continue</button>
    </form>
  </div>
</body>
</html>`;
}
