import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { handleRecoveryConfirm, createServerRecoveryDeps, type RecoveryConfirmDeps, type CookieToSet } from "./recoveryConfirmRoute";
import { RECOVERY_OTP_TYPE } from "./recoveryConfirm";

const ORIGIN = "https://aibackoffice.app";

function makeRequest(query: Record<string, string | undefined>, cookieHeader = ""): NextRequest {
  const url = new URL("/auth/confirm", ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return new NextRequest(url, cookieHeader ? { headers: { cookie: cookieHeader } } : undefined);
}

/** A deps double whose verifyRecoveryOtp is fully test-controlled. */
function makeDeps(opts: {
  error?: { name?: string; status?: number } | null;
  cookiesToSet?: CookieToSet[];
}): { deps: RecoveryConfirmDeps; verifyRecoveryOtp: ReturnType<typeof vi.fn> } {
  const verifyRecoveryOtp = vi.fn(async (_tokenHash: string, cookieAdapter: { setAll(cookies: CookieToSet[]): void }) => {
    if (opts.cookiesToSet) cookieAdapter.setAll(opts.cookiesToSet);
    return { error: opts.error ?? null };
  });
  return { deps: { verifyRecoveryOtp }, verifyRecoveryOtp };
}

describe("handleRecoveryConfirm — valid recovery token_hash", () => {
  it("calls verifyRecoveryOtp with the token_hash from the URL", async () => {
    const { deps, verifyRecoveryOtp } = makeDeps({ error: null });
    const request = makeRequest({ token_hash: "real-token-hash-value", type: "recovery" });
    await handleRecoveryConfirm(request, deps);
    expect(verifyRecoveryOtp).toHaveBeenCalledTimes(1);
    expect(verifyRecoveryOtp.mock.calls[0][0]).toBe("real-token-hash-value");
  });

  it("redirects to the default /auth/update-password destination on success", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makeRequest({ token_hash: "abc", type: "recovery" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/update-password`);
  });

  it("redirects to an explicit, allow-listed next destination when provided", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makeRequest({ token_hash: "abc", type: "recovery", next: "/dashboard" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/dashboard`);
  });

  it("attaches the session cookies produced by verification to the redirect response", async () => {
    const { deps } = makeDeps({
      error: null,
      cookiesToSet: [
        { name: "sb-access-token", value: "session-token-value" },
        { name: "sb-refresh-token", value: "refresh-token-value" },
      ],
    });
    const request = makeRequest({ token_hash: "abc", type: "recovery" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(response.cookies.get("sb-access-token")?.value).toBe("session-token-value");
    expect(response.cookies.get("sb-refresh-token")?.value).toBe("refresh-token-value");
  });

  it("sets a private, no-store Cache-Control header on the success response", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makeRequest({ token_hash: "abc", type: "recovery" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("passes the request's incoming cookies through getAll() to the verifier", async () => {
    const { deps, verifyRecoveryOtp } = makeDeps({ error: null });
    const request = makeRequest({ token_hash: "abc", type: "recovery" }, "existing-cookie=1");
    await handleRecoveryConfirm(request, deps);
    const cookieAdapter = verifyRecoveryOtp.mock.calls[0][1];
    expect(cookieAdapter.getAll()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "existing-cookie", value: "1" })]));
  });
});

describe("handleRecoveryConfirm — rejected before Supabase is ever called", () => {
  it("rejects a missing token_hash safely, without calling verifyRecoveryOtp", async () => {
    const { deps, verifyRecoveryOtp } = makeDeps({ error: null });
    const request = makeRequest({ type: "recovery" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(verifyRecoveryOtp).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/forgot-password?error=expired`);
  });

  it("rejects a wrong auth type (e.g. 'signup') safely, without calling verifyRecoveryOtp", async () => {
    const { deps, verifyRecoveryOtp } = makeDeps({ error: null });
    const request = makeRequest({ token_hash: "abc", type: "signup" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(verifyRecoveryOtp).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/forgot-password?error=expired`);
  });

  it("rejects a malformed/empty type safely, without calling verifyRecoveryOtp", async () => {
    const { deps, verifyRecoveryOtp } = makeDeps({ error: null });
    const request = makeRequest({ token_hash: "abc", type: "" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(verifyRecoveryOtp).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
  });

  it("rejects a missing type entirely, without calling verifyRecoveryOtp", async () => {
    const { deps, verifyRecoveryOtp } = makeDeps({ error: null });
    const request = makeRequest({ token_hash: "abc" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(verifyRecoveryOtp).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
  });

  it("sets Cache-Control: private, no-store on the rejection response too", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makeRequest({ type: "recovery" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("handleRecoveryConfirm — open-redirect protection", () => {
  it("refuses an arbitrary external next URL and falls back to the default destination", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makeRequest({ token_hash: "abc", type: "recovery", next: "https://evil.example.com" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/update-password`);
  });

  it("refuses a protocol-relative external next URL — an external redirect is impossible", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makeRequest({ token_hash: "abc", type: "recovery", next: "//evil.example.com" });
    const response = await handleRecoveryConfirm(request, deps);
    const location = response.headers.get("location")!;
    expect(location.startsWith(ORIGIN)).toBe(true);
    expect(location).not.toContain("evil.example.com");
  });

  it("refuses an unlisted internal path and falls back to the default destination", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makeRequest({ token_hash: "abc", type: "recovery", next: "/some/other/path" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/update-password`);
  });
});

describe("handleRecoveryConfirm — verifyOtp failure", () => {
  it("redirects to the safe recovery-error state on a rejected token, without exposing the raw error", async () => {
    const { deps } = makeDeps({ error: { name: "AuthApiError", status: 403 } });
    const request = makeRequest({ token_hash: "expired-or-used-token", type: "recovery" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(response.status).toBe(307);
    const location = response.headers.get("location")!;
    expect(location).toBe(`${ORIGIN}/auth/forgot-password?error=expired`);
    expect(location).not.toContain("AuthApiError");
    expect(location).not.toContain("403");
  });
});

describe("handleRecoveryConfirm — no logging of sensitive data", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never logs the raw token_hash, on success or failure", async () => {
    const sensitiveToken = "super-secret-recovery-token-value";
    const errorSpy = vi.spyOn(console, "error");

    const { deps: okDeps } = makeDeps({ error: null });
    await handleRecoveryConfirm(makeRequest({ token_hash: sensitiveToken, type: "recovery" }), okDeps);

    const { deps: failDeps } = makeDeps({ error: { name: "AuthApiError", status: 403 } });
    await handleRecoveryConfirm(makeRequest({ token_hash: sensitiveToken, type: "recovery" }), failDeps);

    const allLoggedText = errorSpy.mock.calls.flat().map((arg) => String(arg)).join(" | ");
    expect(allLoggedText).not.toContain(sensitiveToken);
  });
});

describe("createServerRecoveryDeps — fails closed when Supabase env vars are missing", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalUrl !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalKey !== undefined) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalKey;
  });

  it("returns a deps object that reports an error without attempting a network call", async () => {
    const deps = createServerRecoveryDeps();
    const result = await deps.verifyRecoveryOtp("abc", { getAll: () => [], setAll: () => {} });
    expect(result.error).not.toBeNull();
  });

  it("routes through the same safe error redirect as a real verifyOtp failure, end to end", async () => {
    const deps = createServerRecoveryDeps();
    const request = makeRequest({ token_hash: "abc", type: "recovery" });
    const response = await handleRecoveryConfirm(request, deps);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/forgot-password?error=expired`);
  });
});

describe("RECOVERY_OTP_TYPE literal usage", () => {
  it("is always exactly 'recovery', matching lib/auth/recoveryConfirm.ts", () => {
    expect(RECOVERY_OTP_TYPE).toBe("recovery");
  });
});
