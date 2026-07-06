import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { getTenantContext } from "@/lib/tenant";
import { getMissedCallHistory, getMissedCallSettings } from "@/lib/modules/missedCallRecovery/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) return auth.response!;

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  const settings = await getMissedCallSettings(tenant.tenantId);
  const recent = await getMissedCallHistory(tenant.tenantId, 1);

  return NextResponse.json({
    configured: Boolean(settings?.businessPhone),
    enabled: settings?.enabled ?? false,
    lastRunAt: recent[0]?.created_at ?? null,
    lastRunStatus: recent[0]?.status ?? null,
  });
}
