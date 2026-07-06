import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { getTenantContext } from "@/lib/tenant";
import { getMissedCallHistory } from "@/lib/modules/missedCallRecovery/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) return auth.response!;

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Number(limitParam), 200) : 50;

  const history = await getMissedCallHistory(tenant.tenantId, limit);
  return NextResponse.json({ history });
}
