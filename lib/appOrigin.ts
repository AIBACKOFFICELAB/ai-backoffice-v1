/**
 * Origin used for OPERATIONAL absolute links — links an owner or customer is
 * sent to by SMS or email (for example the owner's Lead Inbox link), and the
 * Stripe redirect origin for Founder Beta Checkout.
 *
 * Rules (fail closed):
 * - An explicitly configured NEXT_PUBLIC_APP_URL is used only when it is a
 *   valid absolute origin (https, or http for localhost). An invalid value
 *   yields null — it never falls back to the Production domain.
 * - The canonical Production origin is used ONLY when Vercel reports the
 *   deployment target as exactly `production` (VERCEL_TARGET_ENV). Preview,
 *   development, any Custom Environment (including `aibo-rd-preview`), and an
 *   unknown target all yield null.
 * - Request Host / X-Forwarded-Host headers are never consulted.
 * - VERCEL_PROJECT_PRODUCTION_URL is never consulted: Vercel sets it on preview
 *   deployments too, so it would point staging back at Production.
 *
 * Public marketing metadata (app/layout.tsx canonical/OpenGraph URLs) is NOT
 * governed by this module; it intentionally identifies the Production website.
 */

export const PRODUCTION_APP_ORIGIN = "https://aibackoffice.app";

type Env = Record<string, string | undefined>;

const present = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

/** Validated absolute origin, or null. Accepts https, or http only for localhost. */
export function validatedAppOrigin(raw: string | undefined): string | null {
  if (!present(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw!.trim());
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  return url.origin;
}

/** Operational origin for this deployment, or null when none may be used. */
export function operationalAppOrigin(env: Env = process.env): string | null {
  const configured = env.NEXT_PUBLIC_APP_URL;
  if (configured !== undefined && configured.trim() !== "") return validatedAppOrigin(configured);
  return env.VERCEL_TARGET_ENV === "production" ? PRODUCTION_APP_ORIGIN : null;
}
