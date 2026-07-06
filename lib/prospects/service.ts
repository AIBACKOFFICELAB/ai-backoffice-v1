import { createServerSupabaseClient } from "@/lib/supabase/server";

export type ProspectIntake = {
  businessName: string;
  contactName?: string;
  email?: string;
  phone?: string;
  businessType?: string;
  message?: string;
};

export async function submitProspectIntake(intake: ProspectIntake) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("platform_prospects")
    .insert({
      business_name: intake.businessName,
      contact_name: intake.contactName ?? null,
      email: intake.email ?? null,
      phone: intake.phone ?? null,
      business_type: intake.businessType ?? null,
      message: intake.message ?? null,
      source: "landing_page_audit_form",
    })
    .select()
    .single();

  if (error) {
    throw new Error(error.message);
  }
  return data;
}

export async function listProspects(limit = 100) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("platform_prospects")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}
