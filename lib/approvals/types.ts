/** Approvals (P0.4, hardened P0.9 Slice A). See docs/AGENT_SECURITY.md. */

/**
 * pending -> approved -> executing -> executed, with rejected/expired as
 * the other terminal states reachable from pending. 'executing' is new in
 * Slice A: a durable marker that exactly one caller has won the
 * compare-and-swap claim to execute this approval (see
 * lib/approvals/store.ts::beginExecution). Once 'executing' is entered the
 * approval always ends at 'executed' — success or failure of the
 * underlying tool is recorded in execution_result, not represented by a
 * different terminal status. Retrying a failed action requires a NEW
 * approval request, not reusing this one — see AGENT_SECURITY.md for the
 * documented guarantee this is (and isn't).
 */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "executing" | "executed";
export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";

export type Approval = {
  id: string;
  tenantId: string;
  agentId: string | null;
  agentRunId: string | null;
  requestedAction: string;
  payload: Record<string, unknown>;
  riskLevel: ApprovalRiskLevel;
  status: ApprovalStatus;
  requestedByType: "agent" | "system";
  requestedById: string | null;
  approverUserId: string | null;
  reason: string | null;
  /** SHA-256 hex digest binding this approval to the exact tenant/agent/
   * run/tool/action/payload it was requested for — see
   * lib/approvals/payloadBinding.ts. Required; every approval is created
   * from a specific tool call in this codebase. */
  payloadDigest: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  expiresAt: string | null;
  executionResult: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type RequestApprovalInput = {
  tenantId: string;
  agentId?: string | null;
  agentRunId?: string | null;
  requestedAction: string;
  payload?: Record<string, unknown>;
  riskLevel?: ApprovalRiskLevel;
  requestedByType?: "agent" | "system";
  requestedById?: string | null;
  expiresAt?: string | null;
  payloadDigest: string;
};
