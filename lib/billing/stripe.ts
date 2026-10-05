import { createHmac, timingSafeEqual } from "crypto";

const STRIPE_API = "https://api.stripe.com/v1";
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies a Stripe-Signature header (scheme v1) against the RAW request body.
 * Constant-time compare, replay window enforced. Returns false for anything
 * malformed — never throws, never trusts an unsigned payload.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!header || !secret) return false;
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2);
    if (k?.trim() === "t") timestamp = v?.trim();
    else if (k?.trim() === "v1" && v) signatures.push(v.trim());
  }
  if (!timestamp || signatures.length === 0 || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig) || sig.length !== expected.length * 2) return false;
    return timingSafeEqual(Buffer.from(sig, "hex"), expected);
  });
}

export type CheckoutConfig = { secretKey: string; priceId: string; appUrl: string };

export function getCheckoutConfig(): CheckoutConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID_FOUNDER_BETA;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://aibackoffice.app").replace(/\/$/, "");
  if (!secretKey || !priceId) return null;
  return { secretKey, priceId, appUrl };
}

/** Creates a $299/mo Founder Beta Checkout Session. Payment truth is NOT
 * derived from the browser returning from this session — only the webhook. */
export async function createFounderBetaCheckoutSession(cfg: CheckoutConfig): Promise<{ url: string; id: string }> {
  const body = new URLSearchParams();
  body.set("mode", "subscription");
  body.set("line_items[0][price]", cfg.priceId);
  body.set("line_items[0][quantity]", "1");
  body.set("success_url", `${cfg.appUrl}/welcome?checkout=complete`);
  body.set("cancel_url", `${cfg.appUrl}/pricing`);
  body.set("billing_address_collection", "auto");
  body.set("custom_fields[0][key]", "business_name");
  body.set("custom_fields[0][label][type]", "custom");
  body.set("custom_fields[0][label][custom]", "Business name");
  body.set("custom_fields[0][type]", "text");
  body.set("metadata[plan]", "founder_beta_299");
  body.set("subscription_data[metadata][plan]", "founder_beta_299");

  const res = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.secretKey}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Stripe checkout session creation failed (${res.status})`);
  const json = (await res.json()) as { url?: string; id?: string };
  if (!json.url || !json.id) throw new Error("Stripe checkout session response missing url");
  return { url: json.url, id: json.id };
}
