import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FORGOT_PASSWORD_HREF,
  FORGOT_PASSWORD_LABEL,
  DEFAULT_NEXT_PATH,
  GENERIC_RESET_MESSAGE,
  MIN_PASSWORD_LENGTH,
  buildRecoveryRedirectUrl,
  resolveNextPath,
  requestPasswordReset,
  validateNewPassword,
  updatePassword,
  safeErrorMessage,
} from "./passwordRecovery";

describe("login page wiring", () => {
  it("points the Forgot password link at /auth/forgot-password", () => {
    expect(FORGOT_PASSWORD_HREF).toBe("/auth/forgot-password");
    expect(FORGOT_PASSWORD_LABEL.length).toBeGreaterThan(0);
  });
});

describe("buildRecoveryRedirectUrl", () => {
  it("routes the emailed reset link through the code-exchange callback, ultimately landing on /auth/update-password", () => {
    const url = buildRecoveryRedirectUrl("https://aibackoffice.app");
    expect(url.startsWith("https://aibackoffice.app/auth/callback")).toBe(true);
    // The `next` param carries the real destination — decode it rather than
    // substring-matching the raw (URL-encoded) query string.
    const parsed = new URL(url);
    expect(parsed.searchParams.get("next")).toBe("/auth/update-password");
  });
});

describe("resolveNextPath", () => {
  it("allows the recovery destination", () => {
    expect(resolveNextPath("/auth/update-password")).toBe("/auth/update-password");
  });

  it("allows the dashboard destination", () => {
    expect(resolveNextPath("/dashboard")).toBe("/dashboard");
  });

  it("rejects an absolute external URL and falls back to the default", () => {
    expect(resolveNextPath("https://evil.example.com")).toBe(DEFAULT_NEXT_PATH);
  });

  it("rejects a protocol-relative URL and falls back to the default", () => {
    expect(resolveNextPath("//evil.example.com")).toBe(DEFAULT_NEXT_PATH);
  });

  it("rejects an unlisted internal path and falls back to the default", () => {
    expect(resolveNextPath("/some/other/internal/path")).toBe(DEFAULT_NEXT_PATH);
  });

  it("falls back to the default when next is missing or empty", () => {
    expect(resolveNextPath(null)).toBe(DEFAULT_NEXT_PATH);
    expect(resolveNextPath(undefined)).toBe(DEFAULT_NEXT_PATH);
    expect(resolveNextPath("")).toBe(DEFAULT_NEXT_PATH);
  });
});

describe("requestPasswordReset", () => {
  const origin = "https://aibackoffice.app";

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the generic message when the email genuinely has no account (Supabase reports no error)", async () => {
    const supabase = { auth: { resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }) } };
    const outcome = await requestPasswordReset(supabase, "real-customer@example.com", origin);
    expect(outcome).toEqual({ message: GENERIC_RESET_MESSAGE });
  });

  it("returns the SAME generic message for an unrelated failure — never a distinguishable signal", async () => {
    const supabase = {
      auth: {
        resetPasswordForEmail: vi
          .fn()
          .mockResolvedValue({ error: { name: "AuthApiError", status: 400, message: "Unable to validate email address: invalid format" } }),
      },
    };
    const outcome = await requestPasswordReset(supabase, "not-an-account@example.com", origin);
    expect(outcome.message).toBe(GENERIC_RESET_MESSAGE);
  });

  it("returns the SAME generic message on a per-recipient rate limit (429) — this is the one status Supabase's cooldown reserves for addresses that actually received mail, so surfacing it distinctly would itself be an enumeration oracle", async () => {
    const supabase = {
      auth: {
        resetPasswordForEmail: vi.fn().mockResolvedValue({ error: { name: "AuthApiError", status: 429 } }),
      },
    };
    const outcome = await requestPasswordReset(supabase, "someone@example.com", origin);
    expect(outcome).toEqual({ message: GENERIC_RESET_MESSAGE });
  });

  it("does not enumerate users: a real email, a fake email, and a rate-limited (429) email all produce identical output", async () => {
    const okClient = { auth: { resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }) } };
    const errClient = {
      auth: {
        resetPasswordForEmail: vi.fn().mockResolvedValue({ error: { name: "AuthApiError", status: 400 } }),
      },
    };
    const rateLimitedClient = {
      auth: {
        resetPasswordForEmail: vi.fn().mockResolvedValue({ error: { name: "AuthApiError", status: 429 } }),
      },
    };
    const [a, b, c] = await Promise.all([
      requestPasswordReset(okClient, "exists@example.com", origin),
      requestPasswordReset(errClient, "does-not-exist@example.com", origin),
      requestPasswordReset(rateLimitedClient, "recently-emailed@example.com", origin),
    ]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("resolves safely (never throws) when the client itself rejects", async () => {
    const supabase = { auth: { resetPasswordForEmail: vi.fn().mockRejectedValue(new Error("network down")) } };
    const outcome = await requestPasswordReset(supabase, "someone@example.com", origin);
    expect(outcome.message).toBe(GENERIC_RESET_MESSAGE);
  });

  it("passes the callback redirect URL through to Supabase", async () => {
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ error: null });
    const supabase = { auth: { resetPasswordForEmail } };
    await requestPasswordReset(supabase, "someone@example.com", origin);
    expect(resetPasswordForEmail).toHaveBeenCalledWith(
      "someone@example.com",
      expect.objectContaining({ redirectTo: buildRecoveryRedirectUrl(origin) })
    );
  });
});

describe("validateNewPassword", () => {
  it("rejects a password shorter than the minimum length", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    expect(validateNewPassword(short, short)).toMatch(/at least/i);
  });

  it("rejects a mismatched confirmation", () => {
    expect(validateNewPassword("correct-horse-battery", "different-value")).toMatch(/do not match/i);
  });

  it("accepts a valid, matching password", () => {
    expect(validateNewPassword("correct-horse-battery", "correct-horse-battery")).toBeNull();
  });
});

describe("updatePassword", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a password mismatch before calling Supabase at all", async () => {
    const updateUser = vi.fn();
    const supabase = { auth: { updateUser } };
    const outcome = await updatePassword(supabase, "password-one", "password-two");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/do not match/i);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("updates successfully and calls Supabase with only the password field", async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: null });
    const supabase = { auth: { updateUser } };
    const outcome = await updatePassword(supabase, "correct-horse-battery", "correct-horse-battery");
    expect(outcome).toEqual({ ok: true, error: null });
    expect(updateUser).toHaveBeenCalledWith({ password: "correct-horse-battery" });
    expect(updateUser).toHaveBeenCalledTimes(1);
  });

  it("returns a safe, generic error when Supabase rejects the update", async () => {
    const updateUser = vi.fn().mockResolvedValue({ error: { name: "AuthApiError", status: 422 } });
    const supabase = { auth: { updateUser } };
    const outcome = await updatePassword(supabase, "correct-horse-battery", "correct-horse-battery");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it("never logs the raw password value, on success or failure", async () => {
    const password = "super-secret-password-value";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const failingSupabase = { auth: { updateUser: vi.fn().mockResolvedValue({ error: { name: "AuthApiError", status: 500 } }) } };
    await updatePassword(failingSupabase, password, password);

    const throwingSupabase = { auth: { updateUser: vi.fn().mockRejectedValue(new Error(`failed for ${password}`)) } };
    await updatePassword(throwingSupabase, password, password);

    const allLoggedText = [...errorSpy.mock.calls, ...logSpy.mock.calls].flat().map((arg) => String(arg)).join(" | ");
    expect(allLoggedText).not.toContain(password);
  });
});

describe("safeErrorMessage", () => {
  it("passes through a real error message", () => {
    expect(safeErrorMessage({ message: "Something specific went wrong" }, "fallback")).toBe(
      "Something specific went wrong"
    );
  });

  it("falls back for a non-error-shaped value", () => {
    expect(safeErrorMessage({}, "fallback text")).toBe("fallback text");
    expect(safeErrorMessage(null, "fallback text")).toBe("fallback text");
    expect(safeErrorMessage(undefined, "fallback text")).toBe("fallback text");
  });
});
