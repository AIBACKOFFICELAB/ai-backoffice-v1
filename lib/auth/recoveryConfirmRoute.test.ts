import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  handleRecoveryConfirmView,
  handleRecoveryConfirmSubmit,
  createServerRecoveryDeps,
  type RecoveryConfirmDeps,
  type CookieToSet,
} from "./recoveryConfirmRoute";
import { RECOVERY_OTP_TYPE } from "./recoveryConfirm";

const ORIGIN = "https://aibackoffice.app";

function makeGetRequest(query: Record<string, string | undefined>, cookieHeader = ""): NextRequest {
  const url = new URL("/auth/confirm", ORIGIN);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return new NextRequest(url, cookieHeader ? { headers: { cookie: cookieHeader } } : undefined);
}

function makePostRequest(form: Record<string, string | undefined>, cookieHeader = ""): NextRequest {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value !== undefined) body.set(key, value);
  }
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (cookieHeader) headers.cookie = cookieHeader;
  return new NextRequest(new URL("/auth/confirm", ORIGIN), { method: "POST", body: body.toString(), headers });
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

describe("handleRecoveryConfirmView (GET) — never consumes the token", () => {
  it("renders the confirmation interstitial for a valid recovery link, without calling Supabase", async () => {
    const request = makeGetRequest({ token_hash: "real-token-hash-value", type: "recovery" });
    const response = handleRecoveryConfirmView(request);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<form method="POST" action="/auth/confirm">');
    expect(html).toContain('name="token_hash"');
    expect(html).toContain('value="real-token-hash-value"');
  });

  it("embeds the resolved next destination as a hidden field", async () => {
    const request = makeGetRequest({ token_hash: "abc", type: "recovery", next: "/dashboard" });
    const response = handleRecoveryConfirmView(request);
    const html = await response.text();
    expect(html).toContain('name="next"');
    expect(html).toContain('value="/dashboard"');
  });

  it("falls back to /auth/update-password as the embedded next when none is given", async () => {
    const request = makeGetRequest({ token_hash: "abc", type: "recovery" });
    const response = handleRecoveryConfirmView(request);
    const html = await response.text();
    expect(html).toContain('value="/auth/update-password"');
  });

  it("HTML-escapes a token_hash containing quotes/angle-brackets so it cannot break out of the attribute or inject a tag", async () => {
    const malicious = '"><script>alert(1)</script>';
    const request = makeGetRequest({ token_hash: malicious, type: "recovery" });
    const response = handleRecoveryConfirmView(request);
    const html = await response.text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("sets Cache-Control: private, no-store on the interstitial response (it embeds a live token)", () => {
    const request = makeGetRequest({ token_hash: "abc", type: "recovery" });
    const response = handleRecoveryConfirmView(request);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rejects a missing token_hash safely, redirecting without rendering any interstitial", () => {
    const request = makeGetRequest({ type: "recovery" });
    const response = handleRecoveryConfirmView(request);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/forgot-password?error=expired`);
  });

  it("rejects a wrong auth type safely, without rendering any interstitial", () => {
    const request = makeGetRequest({ token_hash: "abc", type: "signup" });
    const response = handleRecoveryConfirmView(request);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/forgot-password?error=expired`);
  });

  it("rejects a malformed/empty type safely", () => {
    const request = makeGetRequest({ token_hash: "abc", type: "" });
    const response = handleRecoveryConfirmView(request);
    expect(response.status).toBe(307);
  });

  it("sets Cache-Control: private, no-store on the rejection redirect too", () => {
    const request = makeGetRequest({ type: "recovery" });
    const response = handleRecoveryConfirmView(request);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("handleRecoveryConfirmSubmit (POST) — the only path that consumes the token", () => {
  it("calls verifyRecoveryOtp with the token_hash from the form body", async () => {
    const { deps, verifyRecoveryOtp } = makeDeps({ error: null });
    const request = makePostRequest({ token_hash: "real-token-hash-value", next: "/auth/update-password" });
    await handleRecoveryConfirmSubmit(request, deps);
    expect(verifyRecoveryOtp).toHaveBeenCalledTimes(1);
    expect(verifyRecoveryOtp.mock.calls[0][0]).toBe("real-token-hash-value");
  });

  it("redirects to the default /auth/update-password destination on success", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makePostRequest({ token_hash: "abc" });
    const response = await handleRecoveryConfirmSubmit(request, deps);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/update-password`);
  });

  it("redirects to an explicit, allow-listed next destination when provided", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makePostRequest({ token_hash: "abc", next: "/dashboard" });
    const response = await handleRecoveryConfirmSubmit(request, deps);
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
    const request = makePostRequest({ token_hash: "abc" });
    const response = await handleRecoveryConfirmSubmit(request, deps);
    expect(response.cookies.get("sb-access-token")?.value).toBe("session-token-value");
    expect(response.cookies.get("sb-refresh-token")?.value).toBe("refresh-token-value");
  });

  it("sets a private, no-store Cache-Control header on the success response", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makePostRequest({ token_hash: "abc" });
    const response = await handleRecoveryConfirmSubmit(request, deps);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("passes the request's incoming cookies through getAll() to the verifier", async () => {
    const { deps, verifyRecoveryOtp } = makeDeps({ error: null });
    const request = makePostRequest({ token_hash: "abc" }, "existing-cookie=1");
    await handleRecoveryConfirmSubmit(request, deps);
    const cookieAdapter = verifyRecoveryOtp.mock.calls[0][1];
    expect(cookieAdapter.getAll()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "existing-cookie", value: "1" })]));
  });

  it("rejects a missing token_hash safely, without calling verifyRecoveryOtp", async () => {
    const { deps, verifyRecoveryOtp } = makeDeps({ error: null });
    const request = makePostRequest({ next: "/dashboard" });
    const response = await handleRecoveryConfirmSubmit(request, deps);
    expect(verifyRecoveryOtp).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/forgot-password?error=expired`);
  });

  it("refuses an arbitrary external next value and falls back to the default destination", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makePostRequest({ token_hash: "abc", next: "https://evil.example.com" });
    const response = await handleRecoveryConfirmSubmit(request, deps);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/update-password`);
  });

  it("refuses a protocol-relative next value — an external redirect is impossible", async () => {
    const { deps } = makeDeps({ error: null });
    const request = makePostRequest({ token_hash: "abc", next: "//evil.example.com" });
    const response = await handleRecoveryConfirmSubmit(request, deps);
    const location = response.headers.get("location")!;
    expect(location.startsWith(ORIGIN)).toBe(true);
    expect(location).not.toContain("evil.example.com");
  });

  it("redirects to the safe recovery-error state on a rejected token, without exposing the raw error", async () => {
    const { deps } = makeDeps({ error: { name: "AuthApiError", status: 403 } });
    const request = makePostRequest({ token_hash: "expired-or-used-token" });
    const response = await handleRecoveryConfirmSubmit(request, deps);
    expect(response.status).toBe(307);
    const location = response.headers.get("location")!;
    expect(location).toBe(`${ORIGIN}/auth/forgot-password?error=expired`);
    expect(location).not.toContain("AuthApiError");
    expect(location).not.toContain("403");
  });
});

describe("no logging of sensitive data", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never logs the raw token_hash, on success or failure, GET or POST", async () => {
    const sensitiveToken = "super-secret-recovery-token-value";
    const errorSpy = vi.spyOn(console, "error");

    handleRecoveryConfirmView(makeGetRequest({ token_hash: sensitiveToken, type: "recovery" }));

    const { deps: okDeps } = makeDeps({ error: null });
    await handleRecoveryConfirmSubmit(makePostRequest({ token_hash: sensitiveToken }), okDeps);

    const { deps: failDeps } = makeDeps({ error: { name: "AuthApiError", status: 403 } });
    await handleRecoveryConfirmSubmit(makePostRequest({ token_hash: sensitiveToken }), failDeps);

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
    const request = makePostRequest({ token_hash: "abc" });
    const response = await handleRecoveryConfirmSubmit(request, deps);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/auth/forgot-password?error=expired`);
  });
});

describe("RECOVERY_OTP_TYPE literal usage", () => {
  it("is always exactly 'recovery', matching lib/auth/recoveryConfirm.ts", () => {
    expect(RECOVERY_OTP_TYPE).toBe("recovery");
  });
});
