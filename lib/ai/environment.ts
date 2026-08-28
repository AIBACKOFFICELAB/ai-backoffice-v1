/**
 * Model Gateway environment policy (P0.9 Slice C, finding M-01). No
 * environment/config convention existed anywhere else in this repository
 * before this file (verified by inspection — no NODE_ENV/VERCEL_ENV usage
 * in application code) — this is deliberately small and specific to the
 * one decision that needs it: whether the mock chat/embedding provider may
 * be silently available.
 */

export type GatewayEnvironment = "production" | "development" | "test";

/**
 * Resolves which policy applies. Prefers Vercel's own `VERCEL_ENV`
 * ('production' | 'preview' | 'development') over Node's `NODE_ENV` where
 * available, because Next.js sets NODE_ENV='production' for BOTH a
 * production deploy and a preview deploy — VERCEL_ENV is what actually
 * distinguishes them. Falls back to NODE_ENV outside Vercel (local dev,
 * CI). Vitest sets NODE_ENV='test' by default, which is what makes the
 * whole existing test suite (and the default `mock`-registering behavior
 * dev/CI already relies on) keep working unchanged.
 */
export function resolveGatewayEnvironment(): GatewayEnvironment {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return "test";

  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production") return "production";
  if (vercelEnv) return "development"; // 'preview' | 'development'

  return process.env.NODE_ENV === "production" ? "production" : "development";
}

/**
 * Whether the mock chat/embedding provider may be registered at all.
 * `production` is fail-closed by default: no real provider configured must
 * be a loud configuration error at first use (see
 * lib/ai/providers/registry.ts), never a silent mock fallback. The one
 * escape hatch is an explicit, operator-set override — e.g. for a
 * deliberate staging/demo deployment that intentionally runs on mock
 * output — never an implicit default.
 */
export function isMockProviderAllowed(): boolean {
  if (process.env.AI_GATEWAY_ALLOW_MOCK === "true") return true;
  return resolveGatewayEnvironment() !== "production";
}
