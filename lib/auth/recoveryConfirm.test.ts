import { describe, it, expect } from "vitest";
import {
  RECOVERY_OTP_TYPE,
  RECOVERY_ERROR_PATH,
  RECOVERY_ERROR_QUERY_PARAM,
  RECOVERY_ERROR_QUERY_VALUE,
  isValidRecoveryConfirmRequest,
  buildRecoveryErrorUrl,
} from "./recoveryConfirm";

describe("RECOVERY_OTP_TYPE", () => {
  it("is exactly 'recovery'", () => {
    expect(RECOVERY_OTP_TYPE).toBe("recovery");
  });
});

describe("isValidRecoveryConfirmRequest", () => {
  it("accepts a non-empty token_hash with type exactly 'recovery'", () => {
    expect(isValidRecoveryConfirmRequest("abc123", "recovery")).toBe(true);
  });

  it("rejects a missing token_hash", () => {
    expect(isValidRecoveryConfirmRequest(null, "recovery")).toBe(false);
    expect(isValidRecoveryConfirmRequest(undefined, "recovery")).toBe(false);
  });

  it("rejects an empty-string token_hash", () => {
    expect(isValidRecoveryConfirmRequest("", "recovery")).toBe(false);
  });

  it("rejects a missing type", () => {
    expect(isValidRecoveryConfirmRequest("abc123", null)).toBe(false);
    expect(isValidRecoveryConfirmRequest("abc123", undefined)).toBe(false);
  });

  it("rejects any type other than 'recovery' — this endpoint is recovery-only", () => {
    expect(isValidRecoveryConfirmRequest("abc123", "signup")).toBe(false);
    expect(isValidRecoveryConfirmRequest("abc123", "invite")).toBe(false);
    expect(isValidRecoveryConfirmRequest("abc123", "magiclink")).toBe(false);
    expect(isValidRecoveryConfirmRequest("abc123", "email_change")).toBe(false);
    expect(isValidRecoveryConfirmRequest("abc123", "email")).toBe(false);
  });

  it("rejects a case-mismatched or malformed type", () => {
    expect(isValidRecoveryConfirmRequest("abc123", "Recovery")).toBe(false);
    expect(isValidRecoveryConfirmRequest("abc123", "RECOVERY")).toBe(false);
    expect(isValidRecoveryConfirmRequest("abc123", "")).toBe(false);
    expect(isValidRecoveryConfirmRequest("abc123", "recovery ")).toBe(false);
  });
});

describe("buildRecoveryErrorUrl", () => {
  it("always resolves to the fixed internal forgot-password path on the given origin", () => {
    const url = buildRecoveryErrorUrl("https://aibackoffice.app");
    expect(url.origin).toBe("https://aibackoffice.app");
    expect(url.pathname).toBe(RECOVERY_ERROR_PATH);
    expect(url.searchParams.get(RECOVERY_ERROR_QUERY_PARAM)).toBe(RECOVERY_ERROR_QUERY_VALUE);
  });

  it("works identically across every production hostname this app is reachable through", () => {
    for (const origin of ["https://aibackoffice.app", "https://www.aibackoffice.app", "https://ai-backoffice-v1.vercel.app"]) {
      const url = buildRecoveryErrorUrl(origin);
      expect(url.toString().startsWith(origin)).toBe(true);
      expect(url.pathname).toBe("/auth/forgot-password");
    }
  });

  it("never carries a raw Supabase error message or token data — only the fixed generic marker", () => {
    const url = buildRecoveryErrorUrl("https://aibackoffice.app");
    const paramNames = Array.from(url.searchParams.keys());
    expect(paramNames).toEqual([RECOVERY_ERROR_QUERY_PARAM]);
  });
});
