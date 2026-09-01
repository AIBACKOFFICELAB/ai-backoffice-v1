import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { updateLead, createLead, deleteLead, getLeadById } from "@/lib/leads/repository";
import { getTenantContext } from "@/lib/tenant";
import { LeadUpdate } from "@/data/leadModel";
import { validateEstimateSentTransition, markEstimateSent, createLiveMarkEstimateSentDeps } from "@/lib/leads/estimateLifecycle";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

export async function PUT(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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
  const transitioningToEstimateSent = payload.status === "Estimate Sent";

  // P1 Sprint 4 — validate BEFORE any write when the request would set
  // status to "Estimate Sent": an invalid amount or an already-closed lead
  // must refuse the whole request, writing nothing, rather than persisting
  // a bad status change and only failing on the enrollment side-effect
  // after the fact (see lib/leads/estimateLifecycle.ts's doc comment and
  // the PR's Gate 2 audit for why this path needed hardening).
  let wasAlreadyEstimateSent = false;
  let expectedCurrentStatus: string | undefined;
  if (transitioningToEstimateSent) {
    const { lead: existing } = await getLeadById(id, tenant.tenantId);
    if (!existing) {
      // Deliberately the same response as "not found" for a cross-tenant
      // id — getLeadById is already tenant-scoped, so this branch covers
      // both "doesn't exist" and "exists in another tenant" without ever
      // distinguishing the two (which would itself leak cross-tenant
      // existence information).
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }
    wasAlreadyEstimateSent = existing.status === "Estimate Sent";
    const amount = payload.estimateAmount !== undefined ? payload.estimateAmount : existing.estimateAmount;
    const check = validateEstimateSentTransition(existing.status, amount);
    if (!check.ok) {
      if (check.reason === "invalid_amount") {
        return NextResponse.json({ error: "Enter a valid estimate amount (greater than $0) before marking this lead Estimate Sent." }, { status: 400 });
      }
      return NextResponse.json({ error: `This lead is already ${existing.status} and cannot be marked Estimate Sent.` }, { status: 409 });
    }
    // Compare-and-swap: only apply this write if the lead's status in
    // Supabase still matches what was just validated against — see
    // lib/leads/supabase.ts::updateLeadInDb's doc comment. Prevents a
    // concurrent request that closes the lead (Won/Lost/Completed) between
    // the read above and this write from being silently overwritten back
    // to "Estimate Sent" (Codex review finding on PR #23).
    expectedCurrentStatus = existing.status;
  }

  let updatedLead = await updateLead(id, payload, tenant.tenantId, transitioningToEstimateSent ? { expectedCurrentStatus } : {});

  if (!updatedLead) {
    const { lead: sourceLead, source: sourceLeadSource } = await getLeadById(id, tenant.tenantId);
    if (!sourceLead) {
      return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    }
    if (transitioningToEstimateSent && sourceLeadSource === "supabase") {
      // The lead DOES exist in Supabase — the CAS write above matched zero
      // rows because its status changed concurrently since validation, not
      // because it needs a Google-Sheets shadow-write. Refuse rather than
      // silently applying a stale transition.
      return NextResponse.json({ error: "This lead's status changed since you loaded it — please refresh and try again." }, { status: 409 });
    }
    // Lead exists in Google Sheets but not yet in Supabase — shadow-write it into this tenant
    updatedLead = await createLead({ ...sourceLead, ...payload, id }, tenant.tenantId);
  }

  // Canonical estimate-lifecycle transition: enrolls the lead in the Day
  // 1/3/7 follow-up sequence exactly once, idempotently, and records
  // estimate.sent exactly once (docs/constitution/05_MVP_CONSTITUTION.md
  // #2; lib/leads/estimateLifecycle.ts). Awaited (not fire-and-forget) so
  // a genuine enrollment failure is at least observable in this response;
  // the lead's own status/amount change above is never rolled back on an
  // enrollment failure — see estimateLifecycle.ts's doc comment on
  // "enrollment_failed" and the read model's "missing sequence"
  // diagnostic, which is what exists to catch this in production.
  let estimateLifecycle: { outcome: string; sequenceCreated: boolean } | undefined;
  if (updatedLead && transitioningToEstimateSent) {
    try {
      const result = await markEstimateSent(updatedLead, tenant.tenantId, wasAlreadyEstimateSent, tenant.userId, createLiveMarkEstimateSentDeps());
      estimateLifecycle = { outcome: result.outcome, sequenceCreated: result.sequenceCreated };
      if (result.outcome === "enrollment_failed") {
        console.error("[estimate-followup] enrollment failed for lead", id);
      }
    } catch (error) {
      console.error("[estimate-followup] markEstimateSent threw", error);
    }
  }

  return NextResponse.json({ lead: updatedLead, ...(estimateLifecycle ? { estimateLifecycle } : {}) });
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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
