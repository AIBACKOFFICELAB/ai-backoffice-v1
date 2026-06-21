import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { updateLead, deleteLead, getLeadById } from "@/lib/leads/repository";
import { LeadUpdate } from "@/data/leadModel";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) {
    return auth.response!;
  }

  const { id } = params;
  const { lead } = await getLeadById(id);
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

  let payload: LeadUpdate;
  try {
    payload = (await request.json()) as LeadUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const { id } = params;
  const updatedLead = await updateLead(id, payload);
  if (!updatedLead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  return NextResponse.json({ lead: updatedLead });
}

export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await checkAuth(request);
  if (!auth.authenticated) {
    return auth.response!;
  }

  const { id } = params;
  try {
    await deleteLead(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
