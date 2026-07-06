import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { getTenantContext } from "@/lib/tenant";
import { getMissedCallSettings, updateMissedCallSettings } from "@/lib/modules/missedCallRecovery/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) return auth.response!;

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  const settings = await getMissedCallSettings(tenant.tenantId);
  if (!settings) {
    return NextResponse.json({ error: "Module not configured for this tenant" }, { status: 404 });
  }

  return NextResponse.json({ settings });
}

export async function PUT(request: NextRequest) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) return auth.response!;

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  try {
    await updateMissedCallSettings(tenant.tenantId, {
      enabled: payload.enabled as boolean | undefined,
      businessPhone: payload.businessPhone as string | undefined,
      smsTemplate: payload.smsTemplate as string | undefined,
      ownerAlertPhone: payload.ownerAlertPhone as string | undefined,
      emergencyKeywords: payload.emergencyKeywords as string[] | undefined,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
