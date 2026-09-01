// SSR token-hash password-recovery confirmation — the canonical recovery
// mechanism per Supabase's current SSR guidance, replacing dependence on the
// PKCE code_verifier for password recovery (see AUTH_SETUP.md for the
// production incident this fixes and the required Supabase email-template
// change). Pure validation/URL-building logic only, kept dependency-free so
// it is unit-testable directly — matches lib/auth/passwordRecovery.ts's
// established convention of testable lib/ logic behind thin app/ wiring.

/**
 * The one auth type this endpoint will ever act on. `type` is compared
 * against this literal — the caller-supplied `type` query param is NEVER
 * forwarded into supabase.auth.verifyOtp() itself; the actual call always
 * passes this hardcoded constant. That makes it structurally impossible for
 * any URL value to select a different OTP type (signup/invite/magiclink/
 * email_change/email) through this route, even if the validation below were
 * somehow bypassed.
 */
export const RECOVERY_OTP_TYPE = "recovery" as const;

// A fixed, safe landing spot for any recovery-confirm failure — missing or
// invalid params, or a rejected verifyOtp call. Always the same internal
// path on the SAME origin as the incoming request, never derived from
// anything caller-supplied, and never carries the underlying Supabase error
// or the token itself — just a generic marker the forgot-password page can
// (optionally) read.
export const RECOVERY_ERROR_PATH = "/auth/forgot-password";
export const RECOVERY_ERROR_QUERY_PARAM = "error";
export const RECOVERY_ERROR_QUERY_VALUE = "expired";

/**
 * Validates the two REQUIRED recovery-confirm params before Supabase is
 * ever called: a non-empty token_hash, and type === "recovery" exactly (not
 * "Recovery", not "signup", not missing). Everything else about the
 * request — including `next` — is resolved separately through
 * passwordRecovery.ts's existing resolveNextPath allow-list, reused as-is
 * rather than duplicated here.
 */
export function isValidRecoveryConfirmRequest(
  tokenHash: string | null | undefined,
  type: string | null | undefined
): tokenHash is string {
  return typeof tokenHash === "string" && tokenHash.length > 0 && type === RECOVERY_OTP_TYPE;
}

/**
 * Builds the safe failure-redirect URL. `origin` is the incoming request's
 * own origin (never caller-supplied as a raw redirect target) — this exists
 * purely so failures land back on a real, internal page instead of a raw
 * error response.
 */
export function buildRecoveryErrorUrl(origin: string): URL {
  const url = new URL(RECOVERY_ERROR_PATH, origin);
  url.searchParams.set(RECOVERY_ERROR_QUERY_PARAM, RECOVERY_ERROR_QUERY_VALUE);
  return url;
}
