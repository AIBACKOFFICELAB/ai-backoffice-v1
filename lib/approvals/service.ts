import { Approval, RequestApprovalInput } from "./types";
import { ApprovalStore, SupabaseApprovalStore } from "./store";

const defaultStore = new SupabaseApprovalStore();

export async function requestApproval(input: RequestApprovalInput, store: ApprovalStore = defaultStore): Promise<Approval> {
  if (!input.tenantId) throw new Error("requestApproval requires tenantId");
  if (!input.requestedAction) throw new Error("requestApproval requires requestedAction");
  if (!input.payloadDigest) throw new Error("requestApproval requires payloadDigest (see lib/approvals/payloadBinding.ts)");
  return store.create(input);
}

/**
 * Approve — requires the acting user to hold the tenant's 'owner' role.
 * Callers (API routes) must resolve and pass the approver's tenant role;
 * this function refuses to guess it, matching how every other mutation in
 * this codebase makes its authorization decision in application code, not
 * inside an RLS policy (see docs/AGENT_SECURITY.md).
 */
export async function approveApproval(
  tenantId: string,
  approvalId: string,
  approverUserId: string,
  approverRole: "owner" | "staff",
  store: ApprovalStore = defaultStore
): Promise<Approval> {
  if (approverRole !== "owner") {
    throw new Error("only a tenant owner may approve an agent action");
  }
  const approval = await store.getById(tenantId, approvalId);
  if (!approval) throw new Error(`approval ${approvalId} not found`);
  if (approval.status !== "pending") {
    throw new Error(`approval ${approvalId} is '${approval.status}', not 'pending' — cannot approve`);
  }
  if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
    await store.decide(tenantId, approvalId, { status: "expired" });
    throw new Error(`approval ${approvalId} has expired`);
  }
  return store.decide(tenantId, approvalId, { status: "approved", approverUserId });
}

export async function rejectApproval(
  tenantId: string,
  approvalId: string,
  approverUserId: string,
  approverRole: "owner" | "staff",
  reason?: string,
  store: ApprovalStore = defaultStore
): Promise<Approval> {
  if (approverRole !== "owner") {
    throw new Error("only a tenant owner may reject an agent action");
  }
  const approval = await store.getById(tenantId, approvalId);
  if (!approval) throw new Error(`approval ${approvalId} not found`);
  if (approval.status !== "pending") {
    throw new Error(`approval ${approvalId} is '${approval.status}', not 'pending' — cannot reject`);
  }
  return store.decide(tenantId, approvalId, { status: "rejected", approverUserId, reason: reason ?? null });
}

export async function listPendingApprovals(tenantId: string, store: ApprovalStore = defaultStore): Promise<Approval[]> {
  return store.listByTenant(tenantId, { status: "pending" });
}
