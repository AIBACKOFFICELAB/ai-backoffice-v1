import { createServerSupabaseClient } from "@/lib/supabase/server";

export type TenantContext = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: "owner" | "staff";
  /** The resolved, AUTHENTICATED Supabase user id (P0.9 Slice C, finding
   * M-02) — never a caller-supplied claim. See
   * lib/approvals/service.ts::resolveApprovalActor, the first consumer
   * that needs this alongside role. */
  userId: string;
};

/**
 * Resolves the tenant the currently authenticated user belongs to.
 * Founder Deployment assumes one membership per user (single-tenant login);
 * this is the seam future multi-tenant-per-user work (org switching) hangs off.
 */
export async function getTenantContext(): Promise<TenantContext | null> {
  const ctx = await getTenantContextUnchecked();
  if (!ctx) return null;
  // Server-authoritative entitlement: a tenant WITH a billing record must be
  // entitled. Tenants without one (Founder/internal/pilot) are unaffected.
  // Fails closed if the billing lookup errors. Applies to every API route
  // and page that resolves the tenant through this seam.
  const billing = await getBillingState(ctx.tenantId);
  if (billing === "error") return null;
  if (billing && billing.entitlement !== "active") return null;
  return ctx;
}

export type BillingState = {
  entitlement: "active" | "restricted" | "revoked";
  onboardingStatus: "onboarding_required" | "in_progress" | "complete";
  subscriptionStatus: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
};

/** null = no billing record (internal/pilot tenant); "error" = lookup failed. */
export async function getBillingState(tenantId: string): Promise<BillingState | null | "error"> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("billing_subscriptions")
    .select("entitlement, onboarding_status, subscription_status, cancel_at_period_end, current_period_end")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) return "error";
  if (!data) return null;
  return {
    entitlement: data.entitlement,
    onboardingStatus: data.onboarding_status,
    subscriptionStatus: data.subscription_status,
    cancelAtPeriodEnd: data.cancel_at_period_end,
    currentPeriodEnd: data.current_period_end,
  };
}

/** Membership resolution WITHOUT the entitlement check — only for the
 * billing/onboarding surfaces that must still work for a restricted tenant. */
export async function getTenantContextUnchecked(): Promise<TenantContext | null> {
  const supabase = await createServerSupabaseClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from("tenant_memberships")
    .select("tenant_id, role, tenants:tenant_id (name, slug)")
    .eq("user_id", user.id)
    .single();

  if (error || !data) {
    return null;
  }

  const tenant = Array.isArray(data.tenants) ? data.tenants[0] : data.tenants;

  return {
    tenantId: data.tenant_id,
    tenantName: tenant?.name ?? "Unknown Business",
    tenantSlug: tenant?.slug ?? "",
    role: data.role as "owner" | "staff",
    userId: user.id,
  };
}

export type TenantProfile = {
  name: string;
  businessType: string | null;
  phone: string | null;
  email: string | null;
};

export async function getTenantProfile(tenantId: string): Promise<TenantProfile | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("tenants")
    .select("name, business_type, phone, email")
    .eq("id", tenantId)
    .single();

  if (error || !data) return null;

  return {
    name: data.name,
    businessType: data.business_type,
    phone: data.phone,
    email: data.email,
  };
}

export async function updateTenantProfile(
  tenantId: string,
  profile: Partial<TenantProfile>
): Promise<boolean> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("tenants")
    .update({
      ...(profile.name !== undefined ? { name: profile.name } : {}),
      ...(profile.businessType !== undefined ? { business_type: profile.businessType } : {}),
      ...(profile.phone !== undefined ? { phone: profile.phone } : {}),
      ...(profile.email !== undefined ? { email: profile.email } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", tenantId);

  return !error;
}
