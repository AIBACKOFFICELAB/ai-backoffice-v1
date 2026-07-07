import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { getTenantContext, updateTenantProfile } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) {
    return auth.response!;
  }

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  if (tenant.role !== "owner") {
    return NextResponse.json({ error: "Only the account owner can update business profile settings." }, { status: 403 });
  }

  let payload: { name?: string; businessType?: string; phone?: string; email?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  if (payload.name !== undefined && !payload.name.trim()) {
    return NextResponse.json({ error: "Business name can't be empty." }, { status: 400 });
  }

  const ok = await updateTenantProfile(tenant.tenantId, payload);
  if (!ok) {
    return NextResponse.json({ error: "Failed to save business profile." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
