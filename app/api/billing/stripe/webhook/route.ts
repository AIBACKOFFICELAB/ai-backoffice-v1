import { NextRequest, NextResponse } from "next/server";
import { fetchStripeSubscription, verifyStripeSignature } from "@/lib/billing/stripe";
import { processStripeEvent, type StripeEvent } from "@/lib/billing/webhook";
import { createSupabaseBillingStore } from "@/lib/billing/provision.server";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook — the ONLY source of payment truth. Signature is verified
 * against the raw body before anything is parsed or trusted.
 */
export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (!verifyStripeSignature(raw, request.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET)) {
    console.warn("[billing] webhook rejected: invalid signature");
    return NextResponse.json({ ok: false, reason: "invalid-signature" }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
    if (!event?.id || !event?.type || !event?.data?.object) throw new Error("malformed");
  } catch {
    return NextResponse.json({ ok: false, reason: "malformed-event" }, { status: 400 });
  }

  try {
    const result = await processStripeEvent(event, createSupabaseBillingStore(), fetchStripeSubscription);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[billing] webhook processing failed", { eventId: event.id, type: event.type, error: error instanceof Error ? error.message : error });
    return NextResponse.json({ ok: false, reason: "processing-failed" }, { status: 500 });
  }
}
