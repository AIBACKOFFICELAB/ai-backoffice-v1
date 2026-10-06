import type { Entitlement } from "./entitlement";

export const FOUNDER_BETA_PLAN_ID = "founder_beta_299";

/** Bounded, PII-free reconciliation codes persisted to stripe_webhook_events.error. */
export type ReconcileReason =
  | "multiple_memberships"
  | "non_owner_membership"
  | "no_prior_founder_beta_billing"
  | "multiple_billing_rows"
  | "prior_billing_not_founder_beta"
  | "prior_entitlement_active"
  | "prior_entitlement_restricted";

export class ReconciliationRequiredError extends Error {
  constructor(public readonly reason: ReconcileReason) {
    super(`RECONCILIATION_REQUIRED:${reason}`);
  }
}

export type MembershipFact = {
  tenantId: string;
  role: string;
  /** true when this tenant is the one deterministically derived for THIS subscription (a retry of our own provisioning). */
  isThisSubscriptionTenant: boolean;
  billing: Array<{ plan: string; entitlement: Entitlement }>;
};

export type TenantDecision =
  | { kind: "new" } // no prior membership: ordinary new-customer path
  | { kind: "continue"; tenantId: string } // retry of this subscription's own partially-completed provisioning
  | { kind: "reuse"; tenantId: string }; // safe re-subscription of an ended Founder Beta customer

/**
 * Pure: decides which tenant a paid Founder Beta purchaser lands in.
 * Reuse is allowed ONLY for exactly one owner membership whose tenant holds
 * exactly one Founder Beta billing row with entitlement `revoked`. Every
 * other existing-membership shape is ambiguous and requires Founder
 * reconciliation (throws ReconciliationRequiredError) — never silently
 * overwritten, never a second tenant.
 */
export function decideTenantForPurchaser(memberships: MembershipFact[]): TenantDecision {
  if (memberships.length === 0) return { kind: "new" };
  if (memberships.length > 1) throw new ReconciliationRequiredError("multiple_memberships");
  const [m] = memberships;
  if (m.role !== "owner") throw new ReconciliationRequiredError("non_owner_membership");
  if (m.isThisSubscriptionTenant && m.billing.length === 0) return { kind: "continue", tenantId: m.tenantId };
  if (m.billing.length === 0) throw new ReconciliationRequiredError("no_prior_founder_beta_billing");
  if (m.billing.length > 1) throw new ReconciliationRequiredError("multiple_billing_rows");
  const [b] = m.billing;
  if (b.plan !== FOUNDER_BETA_PLAN_ID) throw new ReconciliationRequiredError("prior_billing_not_founder_beta");
  if (b.entitlement === "active") throw new ReconciliationRequiredError("prior_entitlement_active");
  if (b.entitlement === "restricted") throw new ReconciliationRequiredError("prior_entitlement_restricted");
  return { kind: "reuse", tenantId: m.tenantId };
}
