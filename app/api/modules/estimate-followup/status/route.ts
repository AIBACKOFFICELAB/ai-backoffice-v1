import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { getTenantContext } from "@/lib/tenant";
import { getEstimateFollowupHistory, getEstimateFollowupSettings } from "@/lib/modules/estimateFollowup/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) return auth.response!;

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  const settings = await getEstimateFollowupSettings(tenant.tenantId);
  const recent = await getEstimateFollowupHistory(tenant.tenantId, 1);

  return NextResponse.json({
    enabled: settings?.enabled ?? false,
    lastEventAt: recent[0]?.occurred_at ?? null,
    lastEventType: recent[0]?.event_type ?? null,
  });
}
