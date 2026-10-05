import { entitlementForStatus, type Entitlement } from "./entitlement";

export const FOUNDER_BETA_PLAN = "founder_beta_299";

export type StripeEvent = { id: string; type: string; created?: number; data: { object: Record<string, any> } };

/** Authoritative current subscription state, read from Stripe at processing time. */
export type StripeSubscriptionSnapshot = {
  id: string;
  status: string;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  canceled_at?: number | null;
  metadata?: Record<string, string>;
  items?: { data?: Array<{ current_period_end?: number }> };
};
export type SubscriptionFetcher = (subscriptionId: string) => Promise<StripeSubscriptionSnapshot>;

export type ProvisionInput = {
  email: string;
  businessName: string;
  customerId: string;
  subscriptionId: string;
  subscriptionStatus: string;
  entitlement: Entitlement;
  currentPeriodEnd: string | null;
};

export type SubscriptionPatch = {
  subscription_status?: string;
  entitlement?: Entitlement;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean;
  canceled_at?: string | null;
};

export type BillingStore = {
  /** Atomically claims an event id. "duplicate" = already fully processed. */
  claimEvent(eventId: string, eventType: string): Promise<"new" | "retry" | "duplicate">;
  finishEvent(eventId: string, status: "processed" | "failed", error?: string): Promise<void>;
  /** Idempotent: find-or-create user, tenant, owner membership, billing row. */
  provision(input: ProvisionInput): Promise<void>;
  /** Returns false when no billing row exists for that subscription. */
  updateSubscription(subscriptionId: string, patch: SubscriptionPatch): Promise<boolean>;
  getEntitlement(subscriptionId: string): Promise<Entitlement | null>;
};

export type WebhookResult = { outcome: "processed" | "duplicate" | "ignored"; detail?: string };

const iso = (seconds: unknown) => (typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null);

function isFounderBeta(obj: Record<string, any>): boolean {
  return (obj.metadata?.plan ?? obj.subscription_details?.metadata?.plan ?? obj.lines?.data?.[0]?.metadata?.plan) === FOUNDER_BETA_PLAN;
}

export async function processStripeEvent(event: StripeEvent, store: BillingStore, fetchSubscription: SubscriptionFetcher): Promise<WebhookResult> {
  const claim = await store.claimEvent(event.id, event.type);
  if (claim === "duplicate") return { outcome: "duplicate" };

  try {
    const result = await dispatch(event, store, fetchSubscription);
    await store.finishEvent(event.id, "processed");
    return result;
  } catch (err) {
    await store.finishEvent(event.id, "failed", err instanceof Error ? err.message.slice(0, 500) : "unknown error");
    throw err; // -> HTTP 500 so Stripe retries
  }
}

/**
 * Order-independence: webhook delivery order is not guaranteed, so a stale
 * event must never decide entitlement. Every subscription/invoice event is
 * treated only as a *signal*; the state we persist is the subscription's
 * CURRENT state read from Stripe at processing time. Replaying an older
 * "active" event after a failure/cancellation therefore re-reads the
 * newer authoritative state and cannot restore access.
 */
async function syncFromStripe(subscriptionId: string, store: BillingStore, fetchSubscription: SubscriptionFetcher): Promise<{ found: boolean; status: string }> {
  const sub = await fetchSubscription(subscriptionId);
  const found = await store.updateSubscription(subscriptionId, {
    subscription_status: sub.status,
    entitlement: entitlementForStatus(sub.status),
    current_period_end: iso(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end),
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    canceled_at: iso(sub.canceled_at),
  });
  return { found, status: sub.status };
}

async function dispatch(event: StripeEvent, store: BillingStore, fetchSubscription: SubscriptionFetcher): Promise<WebhookResult> {
  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription" || !isFounderBeta(obj)) return { outcome: "ignored", detail: "not-founder-beta" };
      // Entitlement requires server-confirmed payment, never the browser return.
      if (obj.payment_status !== "paid") return { outcome: "ignored", detail: "not-paid" };
      const email = String(obj.customer_details?.email ?? obj.customer_email ?? "").trim().toLowerCase();
      if (!email || typeof obj.customer !== "string" || typeof obj.subscription !== "string") {
        throw new Error("checkout.session.completed missing email/customer/subscription");
      }
      const field = (obj.custom_fields as any[] | undefined)?.find((f) => f?.key === "business_name");
      const businessName = String(field?.text?.value ?? "").trim() || email;
      const current = await fetchSubscription(obj.subscription); // authoritative, not the checkout snapshot
      await store.provision({
        email,
        businessName: businessName.slice(0, 120),
        customerId: obj.customer,
        subscriptionId: obj.subscription,
        subscriptionStatus: current.status,
        entitlement: entitlementForStatus(current.status),
        currentPeriodEnd: iso(current.current_period_end ?? current.items?.data?.[0]?.current_period_end),
      });
      return { outcome: "processed", detail: "provisioned" };
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (!isFounderBeta(obj)) return { outcome: "ignored", detail: "not-founder-beta" };
      const { found, status } = await syncFromStripe(obj.id, store, fetchSubscription);
      // Out-of-order delivery: subscription event can precede checkout.completed. Retry later.
      if (!found) throw new Error(`subscription ${obj.id} not provisioned yet`);
      return { outcome: "processed", detail: status };
    }

    case "invoice.payment_failed":
    case "invoice.paid":
    case "invoice.payment_succeeded": {
      const subId = obj.subscription ?? obj.parent?.subscription_details?.subscription;
      if (typeof subId !== "string") return { outcome: "ignored", detail: "no-subscription" };
      if ((await store.getEntitlement(subId)) === null) return { outcome: "ignored", detail: "unknown-subscription" };
      const { status } = await syncFromStripe(subId, store, fetchSubscription);
      return { outcome: "processed", detail: status };
    }

    default:
      return { outcome: "ignored", detail: "unhandled-type" };
  }
}
