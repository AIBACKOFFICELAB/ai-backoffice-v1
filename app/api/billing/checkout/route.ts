import { NextResponse } from "next/server";
import { createFounderBetaCheckoutSession, getCheckoutConfig } from "@/lib/billing/stripe";

export const dynamic = "force-dynamic";

/** Public CTA target: form POST -> 303 to Stripe-hosted Checkout ($299/mo). */
export async function POST() {
  const cfg = getCheckoutConfig();
  if (!cfg) {
    console.error("[billing] checkout unavailable: STRIPE_SECRET_KEY / STRIPE_PRICE_ID_FOUNDER_BETA not configured");
    return NextResponse.json({ ok: false, reason: "checkout-unavailable" }, { status: 503 });
  }
  try {
    const session = await createFounderBetaCheckoutSession(cfg);
    return NextResponse.redirect(session.url, 303);
  } catch (error) {
    console.error("[billing] checkout session creation failed", error);
    return NextResponse.json({ ok: false, reason: "checkout-failed" }, { status: 502 });
  }
}
