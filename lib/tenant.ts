import { createServerSupabaseClient } from "@/lib/supabase/server";

export type TenantContext = {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: "owner" | "staff";
};

/**
 * Resolves the tenant the currently authenticated user belongs to.
 * Founder Deployment assumes one membership per user (single-tenant login);
 * this is the seam future multi-tenant-per-user work (org switching) hangs off.
 */
export async function getTenantContext(): Promise<TenantContext | null> {
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
