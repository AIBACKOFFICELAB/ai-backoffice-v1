import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { getTenantContext, TenantContext } from "@/lib/tenant";
import { approveApprovalAsAuthenticatedActor, rejectApprovalAsAuthenticatedActor } from "./service";
import { Approval } from "./types";

/**
 * P1 Sprint 3 §11 — Human Approval Center UI foundation. This file does
 * NOT introduce new approval-decision logic: approveApprovalAsAuthenticatedActor
 * / rejectApprovalAsAuthenticatedActor already exist, are already the
 * production-facing entrypoints (P0.9 Slice C, finding M-02 — see
 * AGENT_SECURITY.md), and already resolve the acting human EXCLUSIVELY
 * from trusted session context, verify tenant membership, and enforce
 * owner-only via the underlying approveApproval/rejectApproval's own role
 * check. This module is a thin, testable HTTP wrapper around that existing,
 * hardened contract — exactly what the P1 Sprint 3 directive's §11
 * condition requires ("OWNER may approve/reject ONLY if the existing
 * backend contract already supports that safely" — it does).
 *
 * Deliberately does NOT wire any Estimate Closing recommendation into this
 * path — Estimate Closing's approvalPolicy is {} and it is structurally
 * incapable of ever creating an approval (see shadowRunner.ts). This is
 * infrastructure for whatever DOES create approvals in the future (see
 * AGENTIC_ROADMAP.md's dev_test proof-of-concept), not an activation of
 * anything for Estimate Closing.
 */

export type ApprovalDecisionDeps = {
  checkAuth?: (request: NextRequest) => Promise<{ authenticated: boolean; response: NextResponse | null }>;
  resolveTenant?: () => Promise<TenantContext | null>;
  approve?: (tenantId: string, approvalId: string) => Promise<Approval>;
  reject?: (tenantId: string, approvalId: string, reason?: string) => Promise<Approval>;
};

function statusForApprovalError(message: string): number {
  if (message.includes("only a tenant owner") || message.includes("no authenticated tenant member")) return 403;
  if (message.includes("not found")) return 404;
  // A failed CAS (already decided by someone else, already expired, etc.)
  // is a state conflict, not a client input error or a permission denial.
  if (message.includes("not 'pending'") || message.includes("has expired")) return 409;
  return 400;
}

export async function handleApprovalDecision(
  request: NextRequest,
  approvalId: string,
  decision: "approve" | "reject",
  deps: ApprovalDecisionDeps = {}
): Promise<NextResponse> {
  const doCheckAuth = deps.checkAuth ?? checkAuth;
  const resolveTenant = deps.resolveTenant ?? getTenantContext;
  const approve = deps.approve ?? approveApprovalAsAuthenticatedActor;
  const reject = deps.reject ?? rejectApprovalAsAuthenticatedActor;

  const auth = await doCheckAuth(request);
  if (!auth.authenticated) {
    return auth.response ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenant = await resolveTenant();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  if (!approvalId) {
    return NextResponse.json({ error: "Missing approval id." }, { status: 400 });
  }

  let reason: string | undefined;
  if (decision === "reject") {
    const body = await request.json().catch(() => ({}));
    reason = typeof (body as Record<string, unknown>)?.reason === "string" ? ((body as Record<string, unknown>).reason as string) : undefined;
  }

  try {
    const approval = decision === "approve" ? await approve(tenant.tenantId, approvalId) : await reject(tenant.tenantId, approvalId, reason);
    return NextResponse.json({ approval });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: statusForApprovalError(message) });
  }
}
