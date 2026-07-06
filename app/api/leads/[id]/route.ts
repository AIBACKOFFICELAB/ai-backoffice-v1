import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { updateLead, createLead, deleteLead, getLeadById } from "@/lib/leads/repository";
import { getTenantContext } from "@/lib/tenant";
import { enrollLeadInFollowup } from "@/lib/modules/estimateFollowup/service";
import { LeadUpdate } from "@/data/leadModel";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) {
    return auth.response!;
  }

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  const { id } = params;
  const { lead } = await getLeadById(id, tenant.tenantId);
  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  return NextResponse.json({ lead });
}

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) {
    return auth.response!;
  }

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  let payload: LeadUpdate;
  try {
    payload = (await request.json()) as LeadUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const { id } = params;
  let updatedLead = await updateLead(id, payload, tenant.tenantId);

  // Lead exists in Google Sheets but not yet in Supabase — shadow-write it into this tenant
  if (!updatedLead) {
    const { lead: sourceLead } = await getLeadById(id, tenant.tenantId);
    if (!sourceLead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }
    updatedLead = await createLead({ ...sourceLead, ...payload, id }, tenant.tenantId);
  }

  // Trigger: status transitioning to "Estimate Sent" enrolls the lead in the
  // Day 1/3/7 follow-up sequence (docs/constitution/05_MVP_CONSTITUTION.md #2).
  if (updatedLead && payload.status === "Estimate Sent") {
    enrollLeadInFollowup(tenant.tenantId, updatedLead).catch((error) =>
      console.error("[estimate-followup] enrollment failed", error)
    );
  }

  return NextResponse.json({ lead: updatedLead });
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) {
    return auth.response!;
  }

  const tenant = await getTenantContext();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  const { id } = params;
  try {
    await deleteLead(id, tenant.tenantId);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
