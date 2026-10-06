import type { Entitlement } from "./entitlement";
import type { ProvisionInput } from "./webhook";
import { decideTenantForPurchaser, type MembershipFact } from "./tenantResolution";

/** Storage operations the provisioning flow needs. Implemented by the
 * Supabase adapter (provision.server.ts) and by real-Postgres / in-memory
 * test adapters, so the ORDERING below is tested independently of storage. */
export interface ProvisioningOps {
  findBillingTenantBySubscription(subscriptionId: string): Promise<string | null>;
  findOrCreateUser(email: string): Promise<string>;
  findTenantIdBySlug(slug: string): Promise<string | null>;
  createTenant(t: { name: string; slug: string; email: string }): Promise<string>;
  listMemberships(userId: string): Promise<Array<{ tenantId: string; role: string }>>;
  listBilling(tenantId: string): Promise<Array<{ plan: string; entitlement: Entitlement }>>;
  /** Updates the single revoked founder_beta_299 row; returns rows updated. */
  replaceRevokedBilling(tenantId: string, input: ProvisionInput): Promise<number>;
  /** Inserts billing for this subscription (idempotent on stripe_subscription_id). */
  insertBilling(tenantId: string, input: ProvisionInput): Promise<void>;
  /** Insert-if-absent; never alters an existing membership's role. */
  ensureOwnerMembership(tenantId: string, userId: string): Promise<void>;
}

export function tenantSlugForSubscription(subscriptionId: string): string {
  return `beta-${subscriptionId.replace(/[^a-z0-9]/gi, "").slice(-12).toLowerCase()}`;
}

/**
 * Paid Founder Beta provisioning.
 *
 * INVARIANT: no purchaser receives usable tenant membership before the
 * authoritative billing row for that tenant/subscription is durably stored.
 * (A tenant with no billing row is treated as internal by getTenantContext,
 * so membership-before-billing would fail OPEN.) Order for a new customer:
 * user -> tenant -> billing -> membership. Every step is resumable: a retry
 * finds the existing billing row and repairs only the missing membership.
 */
export async function provisionFounderBeta(ops: ProvisioningOps, input: ProvisionInput): Promise<void> {
  // Resume / idempotency: billing already durable for this exact subscription.
  const existingTenant = await ops.findBillingTenantBySubscription(input.subscriptionId);
  if (existingTenant) {
    const userId = await ops.findOrCreateUser(input.email);
    await ops.ensureOwnerMembership(existingTenant, userId); // repair a membership write that failed after billing
    return;
  }

  const userId = await ops.findOrCreateUser(input.email);
  const slug = tenantSlugForSubscription(input.subscriptionId);
  const slugTenantId = await ops.findTenantIdBySlug(slug);

  const facts: MembershipFact[] = [];
  for (const m of await ops.listMemberships(userId)) {
    facts.push({ tenantId: m.tenantId, role: m.role, isThisSubscriptionTenant: m.tenantId === slugTenantId, billing: await ops.listBilling(m.tenantId) });
  }
  const decision = decideTenantForPurchaser(facts); // throws ReconciliationRequiredError when ambiguous

  if (decision.kind === "reuse") {
    // Ended Founder Beta owner re-subscribing: membership already exists; only billing changes.
    const n = await ops.replaceRevokedBilling(decision.tenantId, input);
    if (n !== 1) throw new Error("billing record replacement failed");
    return;
  }

  let tenantId = decision.kind === "continue" ? decision.tenantId : slugTenantId;
  if (!tenantId) tenantId = await ops.createTenant({ name: input.businessName, slug, email: input.email });
  await ops.insertBilling(tenantId, input); // billing FIRST ...
  await ops.ensureOwnerMembership(tenantId, userId); // ... access only after billing is durable
}
