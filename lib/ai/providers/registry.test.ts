import { describe, it, expect, vi, afterEach } from "vitest";
import { getDefaultChatProviders, getDefaultEmbeddingProviders } from "./registry";

/**
 * Model Gateway production fail-closed policy (P0.9 Slice C, finding
 * M-01). Uses vitest's stubEnv/unstubAllEnvs — NODE_ENV is readonly on
 * ProcessEnv, so a raw assignment doesn't typecheck.
 */
describe("getDefaultChatProviders / getDefaultEmbeddingProviders — production fail-closed (M-01)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("test injection of mock -> allowed (this IS the test environment)", () => {
    const providers = getDefaultChatProviders();
    expect(providers.mock).toBeDefined();
  });

  it("development explicit mock policy -> allowed when intentionally in a development environment", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const providers = getDefaultChatProviders();
    expect(providers.mock).toBeDefined();
  });

  it("scenario 2: production + no real provider configured -> fail closed (empty real chat registry, no mock)", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const providers = getDefaultChatProviders();
    expect(providers.mock).toBeUndefined();
    expect(providers.anthropic).toBeUndefined();
    expect(Object.keys(providers)).toHaveLength(0);
  });

  it("scenario 3: production + a real provider IS configured -> real provider available, mock absent", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key-not-a-real-secret");

    const providers = getDefaultChatProviders();
    expect(providers.anthropic).toBeDefined();
    expect(providers.mock).toBeUndefined();
  });

  it("scenario 1 (correction 1): production + AI_GATEWAY_ALLOW_MOCK=true -> mock NOT registered", () => {
    // The escape hatch that could bypass production fail-closed has been
    // removed entirely — set here only to prove it has zero effect.
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_ALLOW_MOCK", "true");

    const providers = getDefaultChatProviders();
    expect(providers.mock).toBeUndefined();
  });

  it("embedding providers follow the identical fail-closed policy, including no AI_GATEWAY_ALLOW_MOCK override", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("AI_GATEWAY_ALLOW_MOCK", "true");

    const providers = getDefaultEmbeddingProviders();
    expect(Object.keys(providers)).toHaveLength(0);
  });
});
