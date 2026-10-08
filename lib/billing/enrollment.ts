/**
 * Founder Beta enrollment gate — server-authoritative, default OFF.
 *
 * Stripe credentials existing in an environment is NOT authorization to take
 * payments. Checkout may create a Stripe session only when the Founder has
 * explicitly set AIBO_FOUNDER_BETA_ENROLLMENT_ENABLED to the exact string
 * "true" AND every value a paid enrollment depends on is configured:
 * secret key, Founder Beta price, webhook signing secret (without it a paid
 * customer could never be provisioned) and a valid absolute app URL for the
 * Stripe redirects (no silent default domain).
 *
 * Passing this gate proves configuration PRESENCE only — not that the Stripe
 * webhook endpoint is registered or that the payment flow has been tested.
 * Activation is a separate Founder decision.
 */

export const ENROLLMENT_FLAG_ENV = "AIBO_FOUNDER_BETA_ENROLLMENT_ENABLED";

export type CheckoutConfig = { secretKey: string; priceId: string; appUrl: string };

export type EnrollmentClosedReason =
  | "disabled"
  | "missing_stripe_secret_key"
  | "missing_price_id"
  | "missing_webhook_secret"
  | "invalid_app_url";

export type EnrollmentGate = { open: true; config: CheckoutConfig } | { open: false; reason: EnrollmentClosedReason };

type Env = Record<string, string | undefined>;

const present = (v: string | undefined) => typeof v === "string" && v.trim().length > 0;

/** Absolute origin for Stripe success/cancel redirects: https, or http only for local development. */
function appOrigin(raw: string | undefined): string | null {
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

export function founderBetaEnrollmentGate(env: Env = process.env): EnrollmentGate {
  if (env[ENROLLMENT_FLAG_ENV] !== "true") return { open: false, reason: "disabled" };
  if (!present(env.STRIPE_SECRET_KEY)) return { open: false, reason: "missing_stripe_secret_key" };
  if (!present(env.STRIPE_PRICE_ID_FOUNDER_BETA)) return { open: false, reason: "missing_price_id" };
  if (!present(env.STRIPE_WEBHOOK_SECRET)) return { open: false, reason: "missing_webhook_secret" };
  const appUrl = appOrigin(env.NEXT_PUBLIC_APP_URL);
  if (!appUrl) return { open: false, reason: "invalid_app_url" };
  return { open: true, config: { secretKey: env.STRIPE_SECRET_KEY!.trim(), priceId: env.STRIPE_PRICE_ID_FOUNDER_BETA!.trim(), appUrl } };
}
