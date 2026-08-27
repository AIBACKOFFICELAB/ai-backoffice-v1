/** Approvals (P0.4). See docs/AGENT_SECURITY.md. */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "executed";
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
};
