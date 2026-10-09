import { NextResponse } from "next/server";
import { createFounderBetaCheckoutSession } from "@/lib/billing/stripe";
import { founderBetaEnrollmentGate } from "@/lib/billing/enrollment";

export const dynamic = "force-dynamic";

/** Public CTA target: form POST -> 303 to Stripe-hosted Checkout ($299/mo).
 * Fails closed unless the Founder Beta enrollment gate is open; no Stripe call
 * is made otherwise. The response never reveals which setting is missing. */
export async function POST() {
  const gate = founderBetaEnrollmentGate();
  if (!gate.open) {
    console.warn("[billing] checkout refused: enrollment gate closed", { reason: gate.reason });
    return NextResponse.json({ ok: false, reason: "enrollment-unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const session = await createFounderBetaCheckoutSession(gate.config);
    return NextResponse.redirect(session.url, 303);
  } catch (error) {
    console.error("[billing] checkout session creation failed", error);
    return NextResponse.json({ ok: false, reason: "checkout-failed" }, { status: 502 });
  }
}
