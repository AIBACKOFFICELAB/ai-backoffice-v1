import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveGatewayEnvironment, isMockProviderAllowed } from "./environment";

/**
 * Model Gateway environment policy (P0.9 Slice C, finding M-01). Uses
 * vitest's stubEnv/unstubAllEnvs (the standard, type-safe way to
 * temporarily override process.env — NODE_ENV is a readonly property on
 * ProcessEnv, so a raw assignment doesn't typecheck).
 */
describe("resolveGatewayEnvironment / isMockProviderAllowed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("test injection of mock -> allowed: vitest's own NODE_ENV='test' resolves to the test policy", () => {
    // This IS the running test environment — no stubbing needed.
    expect(resolveGatewayEnvironment()).toBe("test");
    expect(isMockProviderAllowed()).toBe(true);
  });

  it("VERCEL_ENV='production' with no override -> production, mock NOT allowed", () => {
    // Real Vercel production sets NODE_ENV=production AND VERCEL_ENV=production
    // together — test-detection (VITEST / NODE_ENV=test) intentionally wins
    // over VERCEL_ENV whenever both are present, since that combination only
    // occurs inside a test run, never a real deployment.
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(resolveGatewayEnvironment()).toBe("production");
    expect(isMockProviderAllowed()).toBe(false);
  });

  it("VERCEL_ENV='preview' -> treated as development, mock allowed", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(resolveGatewayEnvironment()).toBe("development");
    expect(isMockProviderAllowed()).toBe(true);
  });

  it("no VERCEL_ENV, NODE_ENV='production' -> production, mock NOT allowed", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(resolveGatewayEnvironment()).toBe("production");
    expect(isMockProviderAllowed()).toBe(false);
  });

  it("scenario: development explicit mock policy -> allowed (no VERCEL_ENV, NODE_ENV=development)", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "development");
    expect(resolveGatewayEnvironment()).toBe("development");
    expect(isMockProviderAllowed()).toBe(true);
  });

  it("scenario (correction 1): production + AI_GATEWAY_ALLOW_MOCK=true -> mock NOT allowed — no override exists for production", () => {
    // Before this correction, this env var could bypass the production
    // fail-closed policy entirely — that defeated the whole invariant.
    // isMockProviderAllowed() no longer reads this variable at all; it is
    // set here only to prove it has zero effect.
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("AI_GATEWAY_ALLOW_MOCK", "true");
    expect(isMockProviderAllowed()).toBe(false);
  });
});
