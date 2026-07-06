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
