// Password recovery — pure, dependency-injected logic shared by
// app/auth/forgot-password, app/auth/update-password, and
// app/auth/callback. Kept separate from the "use client" pages / the
// route handler so it can be unit-tested directly (see
// passwordRecovery.test.ts) without rendering React or invoking Next's
// route-handler runtime, matching this repo's existing convention of
// testable lib/ logic behind thin app/ wiring.

export const FORGOT_PASSWORD_HREF = "/auth/forgot-password";
export const FORGOT_PASSWORD_LABEL = "Forgot password?";

export const MIN_PASSWORD_LENGTH = 8;

// Deliberately identical regardless of whether the email actually belongs
// to an account, and regardless of most failure modes below — this string
// must never become a signal an attacker can use to enumerate accounts.
export const GENERIC_RESET_MESSAGE =
  "If an account exists for that email, we've sent password reset instructions.";

export const GENERIC_UPDATE_ERROR_MESSAGE =
  "We couldn't update your password. Please request a new reset link and try again.";

/**
 * Legacy/compatibility redirect target for resetPasswordForEmail's
 * `redirectTo` option — still passed on every call below, but no longer the
 * security-critical path. The CANONICAL recovery mechanism is now the
 * token-hash route (app/auth/confirm/route.ts, see AUTH_SETUP.md's
 * "Production Hotfix" section): once the Supabase Reset Password email
 * template is switched to `{{ .SiteURL }}/auth/confirm?token_hash=...`, the
 * emailed link is built entirely from that fixed template — NOT from this
 * `redirectTo` value — so it no longer matters which hostname
 * (window.location.origin) the user happened to be on when they submitted
 * the forgot-password form. `redirectTo` is kept here only so
 * resetPasswordForEmail has a harmless, working fallback if the email
 * template has not yet been updated; it was never required for the
 * token-hash flow to succeed.
 *
 * This still points at the PKCE code-exchange callback
 * (app/auth/callback/route.ts) for backward compatibility — see that file's
 * own doc comment. It is not removed; it is simply no longer load-bearing
 * for password recovery specifically.
 */
export function buildRecoveryRedirectUrl(origin: string): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(DEFAULT_NEXT_PATH)}`;
}

// ---------------------------------------------------------------------------
// /auth/callback redirect allow-list
//
// `next` is a value we do not control (it round-trips through an email
// link/URL param), so it is only ever looked up in this fixed Set — never
// interpolated into a redirect target directly. That makes an open
// redirect structurally impossible here, not just unlikely.
// ---------------------------------------------------------------------------

export const DEFAULT_NEXT_PATH = "/auth/update-password";

const ALLOWED_NEXT_PATHS = new Set<string>([DEFAULT_NEXT_PATH, "/dashboard"]);

export function resolveNextPath(nextParam: string | null | undefined): string {
  if (nextParam && ALLOWED_NEXT_PATHS.has(nextParam)) {
    return nextParam;
  }
  return DEFAULT_NEXT_PATH;
}

// ---------------------------------------------------------------------------
// Reset request (/auth/forgot-password)
// ---------------------------------------------------------------------------

type ResetPasswordResult = {
  error: { name?: string; status?: number; message?: string } | null;
};

type ResetPasswordClient = {
  auth: {
    resetPasswordForEmail: (
      email: string,
      options: { redirectTo: string }
    ) => Promise<ResetPasswordResult>;
  };
};

export type PasswordResetOutcome = { message: string };

/**
 * Always resolves — never throws — with the same safe outcome, regardless
 * of whether the email has an account AND regardless of any error
 * Supabase returns, rate-limiting included.
 *
 * Rate-limiting deliberately does NOT get a distinct message: Supabase's
 * reset-email cooldown is scoped per recipient, so an address that
 * recently received a real reset email returns 429 on a repeat request
 * while a nonexistent address never does (no email was ever sent to it,
 * so it never enters a cooldown). Surfacing 429 differently would let an
 * attacker fire two requests at a candidate address and use the second
 * response to infer whether the first one actually sent mail — i.e.
 * whether the account exists. Rate-limit status is only ever logged
 * server-side (console.error below), never returned to the caller.
 */
export async function requestPasswordReset(
  supabase: ResetPasswordClient,
  email: string,
  origin: string
): Promise<PasswordResetOutcome> {
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: buildRecoveryRedirectUrl(origin),
    });
    if (error) {
      // Metadata only — never the email or any part of the error that
      // could echo user-supplied input in a way that invites logging PII
      // beyond what's needed to debug a delivery/config/rate-limit
      // problem. This log line is the ONLY place rate-limit status is
      // observable — it never reaches the returned outcome.
      console.error("[forgot-password] resetPasswordForEmail error:", error.name, error.status);
    }
  } catch (err) {
    console.error(
      "[forgot-password] Unexpected error:",
      err instanceof Error ? err.message : "unknown"
    );
  }
  return { message: GENERIC_RESET_MESSAGE };
}

// ---------------------------------------------------------------------------
// Password update (/auth/update-password)
// ---------------------------------------------------------------------------

export function validateNewPassword(password: string, confirmPassword: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirmPassword) {
    return "Passwords do not match.";
  }
  return null;
}

type UpdateUserResult = {
  error: { name?: string; status?: number } | null;
};

type UpdatePasswordClient = {
  auth: {
    updateUser: (attrs: { password: string }) => Promise<UpdateUserResult>;
  };
};

export type PasswordUpdateOutcome = { ok: boolean; error: string | null };

/**
 * Validates, then calls supabase.auth.updateUser({ password }). The raw
 * password value is never passed to console.error/console.log anywhere in
 * this function or its callers — only error metadata (name/status) is
 * logged on failure.
 */
export async function updatePassword(
  supabase: UpdatePasswordClient,
  password: string,
  confirmPassword: string
): Promise<PasswordUpdateOutcome> {
  const validationError = validateNewPassword(password, confirmPassword);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      console.error("[update-password] updateUser failed:", error.name, error.status);
      return { ok: false, error: GENERIC_UPDATE_ERROR_MESSAGE };
    }
    return { ok: true, error: null };
  } catch (err) {
    console.error(
      "[update-password] Unexpected error:",
      err instanceof Error ? err.name : "unknown"
    );
    return { ok: false, error: GENERIC_UPDATE_ERROR_MESSAGE };
  }
}

/**
 * Supabase auth errors are usually a string `.message`, but a misconfigured
 * client or a non-AuthError failure can surface something that isn't safe
 * to render directly (an empty message, or a raw object that stringifies
 * to "{}"). Mirrors the same defensive pattern already used by
 * app/auth/login/page.tsx.
 */
export function safeErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  if (typeof err === "string" && err.trim().length > 0) return err;
  return fallback;
}
