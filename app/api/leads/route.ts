import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { getLeads } from "@/lib/leads/repository";
import { getTenantContext } from "@/lib/tenant";
import { getTenantProfile } from "@/lib/tenant";
import { createCanonicalLeadFromIntake } from "@/lib/leads/intake/service";
import { createLiveIntakeDeps } from "@/lib/leads/intake/server";
import { intakeFailure, readIntakeBody } from "@/lib/leads/intake/http";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) {
    return auth.response!;
  }

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  const result = await getLeads(tenant.tenantId);
  return NextResponse.json(result);
}

export async function POST(request: NextRequest) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) {
    return auth.response!;
  }

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  try {
    const raw = await readIntakeBody(request);
    const profile = await getTenantProfile(tenant.tenantId);
    const result = await createCanonicalLeadFromIntake(raw, { id: tenant.tenantId, name: tenant.tenantName, email: profile?.email ?? null }, "manual", tenant.userId, createLiveIntakeDeps());
    return NextResponse.json({ lead: result.lead }, { status: result.deduped ? 200 : 201 });
  } catch (error) { return intakeFailure(error); }
}
