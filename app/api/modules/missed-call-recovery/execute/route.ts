import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { getTenantContext } from "@/lib/tenant";
import { executeMissedCallRecovery, getMissedCallSettings } from "@/lib/modules/missedCallRecovery/service";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Manual/internal invocation of the Execution layer for the current tenant —
 * e.g. an owner replaying a missed call recovery from the UI, or a test call
 * during Activation (see docs/constitution/04_SYSTEM_LIFECYCLE.md).
 */
export async function POST(request: NextRequest) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) return auth.response!;

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  let payload: { callerPhone?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (!payload.callerPhone) {
    return NextResponse.json({ error: "callerPhone is required" }, { status: 400 });
  }

  const settings = await getMissedCallSettings(tenant.tenantId);
  if (!settings) {
    return NextResponse.json({ error: "Module not configured for this tenant" }, { status: 404 });
  }

  const supabase = await createServerSupabaseClient();
  const { data: tenantRow } = await supabase.from("tenants").select("name").eq("id", tenant.tenantId).single();

  const result = await executeMissedCallRecovery(
    tenant.tenantId,
    settings,
    { callerPhone: payload.callerPhone, triggerSource: "manual" },
    tenantRow?.name ?? tenant.tenantName
  );

  return NextResponse.json({ result });
}
