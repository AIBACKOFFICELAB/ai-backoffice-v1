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
 *
 * The authoritative decision is `store.decide()`'s atomic
 * `WHERE status = 'pending'` CAS, not a prior read. Concurrent
 * approve/reject/approve calls on the same approval can only ever have one
 * winner — every `getById` in this function is diagnostic-only (a friendly
 * error, or driving the expiry check below), never what decides whether
 * the approve actually happens.
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

  // Diagnostic-only: confirms the id exists at all, and drives the expiry
  // check below. A stale read here cannot cause an incorrect approve to
  // go through — the CAS below re-checks status='pending' atomically.
  const preRead = await store.getById(tenantId, approvalId);
  if (!preRead) throw new Error(`approval ${approvalId} not found`);

  if (preRead.status === "pending" && preRead.expiresAt && new Date(preRead.expiresAt) < new Date()) {
    const expired = await store.decide(tenantId, approvalId, { status: "expired" });
    if (expired) {
      throw new Error(`approval ${approvalId} has expired`);
    }
    // Lost the race to expire it — someone else decided it first (approved
    // or rejected). Fall through: the real approve attempt below will fail
    // its own CAS and report whatever the approval's actual current state
    // is, via the same diagnostic path every other CAS failure uses.
  }

  const decided = await store.decide(tenantId, approvalId, { status: "approved", approverUserId });
  if (!decided) {
    throw new Error(`approval ${approvalId} is ${await describeCurrentStatus(tenantId, approvalId, store)}, not 'pending' — cannot approve`);
  }
  return decided;
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

  const decided = await store.decide(tenantId, approvalId, { status: "rejected", approverUserId, reason: reason ?? null });
  if (!decided) {
    throw new Error(`approval ${approvalId} is ${await describeCurrentStatus(tenantId, approvalId, store)}, not 'pending' — cannot reject`);
  }
  return decided;
}

/** Diagnostic-only read used SOLELY to build a clear error message after a
 * CAS has already failed — never to decide whether an approve/reject
 * should proceed. */
async function describeCurrentStatus(tenantId: string, approvalId: string, store: ApprovalStore): Promise<string> {
  const current = await store.getById(tenantId, approvalId);
  return current ? `'${current.status}'` : "no longer found";
}

export async function listPendingApprovals(tenantId: string, store: ApprovalStore = defaultStore): Promise<Approval[]> {
  return store.listByTenant(tenantId, { status: "pending" });
}
