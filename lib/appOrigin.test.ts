import { describe, expect, it } from "vitest";
import { PRODUCTION_APP_ORIGIN, operationalAppOrigin, validatedAppOrigin } from "./appOrigin";

/**
 * Operational origin resolution for the Staging-origin correction (AIBO-RD-M002A).
 * Pure: no request, no network. Staging = Custom Environment `aibo-rd-preview`.
 */
const STAGING = "aibo-rd-preview";
const PROD_DOMAINS = ["aibackoffice.app", "www.aibackoffice.app"];

describe("staging (aibo-rd-preview) never reaches a Production domain", () => {
  it("with NEXT_PUBLIC_APP_URL absent, no operational origin is returned", () => {
    expect(operationalAppOrigin({ VERCEL_TARGET_ENV: STAGING })).toBeNull();
  });

  it("does not fall back to Production via VERCEL_PROJECT_PRODUCTION_URL, even when that variable names Production", () => {
    const env = { VERCEL_TARGET_ENV: STAGING, VERCEL_PROJECT_PRODUCTION_URL: "aibackoffice.app" };
    expect(operationalAppOrigin(env)).toBeNull();
  });

  it("preview, development and an unknown/unexposed target all fail closed", () => {
    for (const target of ["preview", "development", "", undefined]) {
      expect(operationalAppOrigin({ VERCEL_TARGET_ENV: target }), String(target)).toBeNull();
    }
  });

  it("an invalid configured origin never falls back to Production", () => {
    for (const bad of ["aibackoffice.app", "http://staging.example.test", "https://staging.example.test/path", "javascript:alert(1)", "   "]) {
      const result = operationalAppOrigin({ VERCEL_TARGET_ENV: STAGING, NEXT_PUBLIC_APP_URL: bad });
      expect(result, bad).toBeNull();
    }
  });

  it("a valid operator-configured staging origin is accepted, and it is not a Production domain", () => {
    const result = operationalAppOrigin({ VERCEL_TARGET_ENV: STAGING, NEXT_PUBLIC_APP_URL: "https://staging.example.test/" });
    expect(result).toBe("https://staging.example.test");
    expect(PROD_DOMAINS).not.toContain(new URL(result!).hostname);
  });

  it("no output for staging ever contains a Production domain", () => {
    const cases = [
      { VERCEL_TARGET_ENV: STAGING },
      { VERCEL_TARGET_ENV: STAGING, NEXT_PUBLIC_APP_URL: "https://staging.example.test" },
      { VERCEL_TARGET_ENV: STAGING, NEXT_PUBLIC_APP_URL: "https://aibackoffice.app.evil.example" },
    ];
    for (const env of cases) {
      const out = operationalAppOrigin(env);
      if (out !== null) expect(PROD_DOMAINS).not.toContain(new URL(out).hostname);
    }
  });
});

describe("Production retains its canonical behavior", () => {
  it("VERCEL_TARGET_ENV=production with no configured origin uses the canonical Production origin", () => {
    expect(operationalAppOrigin({ VERCEL_TARGET_ENV: "production" })).toBe(PRODUCTION_APP_ORIGIN);
    expect(PRODUCTION_APP_ORIGIN).toBe("https://aibackoffice.app");
  });

  it("a valid configured origin is used in Production (existing behavior preserved)", () => {
    expect(operationalAppOrigin({ VERCEL_TARGET_ENV: "production", NEXT_PUBLIC_APP_URL: "https://aibackoffice.app" })).toBe("https://aibackoffice.app");
  });

  it("an invalid configured origin in Production fails closed rather than using the canonical default", () => {
    expect(operationalAppOrigin({ VERCEL_TARGET_ENV: "production", NEXT_PUBLIC_APP_URL: "http://aibackoffice.app" })).toBeNull();
  });

  it("local development (no target) and tests get no implicit Production origin", () => {
    expect(operationalAppOrigin({})).toBeNull();
  });
});

describe("validatedAppOrigin rejects untrusted or non-origin input", () => {
  it("accepts https origins and localhost http", () => {
    expect(validatedAppOrigin("https://app.example.test")).toBe("https://app.example.test");
    expect(validatedAppOrigin("https://app.example.test/")).toBe("https://app.example.test");
    expect(validatedAppOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(validatedAppOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it("rejects remote http, paths, queries, fragments, credentials, bare hosts, schemes and empties", () => {
    for (const bad of [
      "http://app.example.test",
      "https://app.example.test/path",
      "https://app.example.test/?next=//evil.example",
      "https://app.example.test/#frag",
      "https://user:pass@app.example.test",
      "app.example.test",
      "//evil.example",
      "javascript:alert(1)",
      "ftp://app.example.test",
      "",
      "   ",
    ]) {
      expect(validatedAppOrigin(bad), bad).toBeNull();
    }
    expect(validatedAppOrigin(undefined)).toBeNull();
  });
});
