import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Approval, ApprovalStatus, RequestApprovalInput } from "./types";

export type DecideApprovalInput = {
  status: Extract<ApprovalStatus, "approved" | "rejected" | "expired" | "executed">;
  approverUserId?: string | null;
  reason?: string | null;
  executionResult?: Record<string, unknown> | null;
};

export interface ApprovalStore {
  create(input: RequestApprovalInput): Promise<Approval>;
  decide(tenantId: string, id: string, input: DecideApprovalInput): Promise<Approval>;
  getById(tenantId: string, id: string): Promise<Approval | null>;
  listByTenant(tenantId: string, opts?: { status?: ApprovalStatus }): Promise<Approval[]>;
}

function mapRow(row: Record<string, any>): Approval {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    agentRunId: row.agent_run_id,
    requestedAction: row.requested_action,
    payload: row.payload ?? {},
    riskLevel: row.risk_level,
    status: row.status,
    requestedByType: row.requested_by_type,
    requestedById: row.requested_by_id,
    approverUserId: row.approver_user_id,
    reason: row.reason,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    expiresAt: row.expires_at,
    executionResult: row.execution_result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SupabaseApprovalStore implements ApprovalStore {
  async create(input: RequestApprovalInput): Promise<Approval> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("approvals")
      .insert({
        tenant_id: input.tenantId,
        agent_id: input.agentId ?? null,
        agent_run_id: input.agentRunId ?? null,
        requested_action: input.requestedAction,
        payload: input.payload ?? {},
        risk_level: input.riskLevel ?? "medium",
        requested_by_type: input.requestedByType ?? "agent",
        requested_by_id: input.requestedById ?? null,
        expires_at: input.expiresAt ?? null,
        status: "pending",
      })
      .select()
      .single();
    if (error) throw new Error(`[approvals] create failed: ${error.message}`);
    return mapRow(data);
  }

  async decide(tenantId: string, id: string, input: DecideApprovalInput): Promise<Approval> {
    const supabase = await createServerSupabaseClient();
    const now = new Date().toISOString();
    const row: Record<string, unknown> = { status: input.status, updated_at: now };
    if (input.approverUserId !== undefined) row.approver_user_id = input.approverUserId;
    if (input.reason !== undefined) row.reason = input.reason;
    if (input.executionResult !== undefined) row.execution_result = input.executionResult;
    if (input.status === "approved") row.approved_at = now;
    if (input.status === "rejected") row.rejected_at = now;

    const { data, error } = await supabase.from("approvals").update(row).eq("tenant_id", tenantId).eq("id", id).select().single();
    if (error) throw new Error(`[approvals] decide failed: ${error.message}`);
    return mapRow(data);
  }

  async getById(tenantId: string, id: string): Promise<Approval | null> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("approvals").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
    if (error || !data) return null;
    return mapRow(data);
  }

  async listByTenant(tenantId: string, opts: { status?: ApprovalStatus } = {}): Promise<Approval[]> {
    const supabase = await createServerSupabaseClient();
    let query = supabase.from("approvals").select("*").eq("tenant_id", tenantId);
    if (opts.status) query = query.eq("status", opts.status);
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw new Error(`[approvals] list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }
}

export class InMemoryApprovalStore implements ApprovalStore {
  private rows: Approval[] = [];

  async create(input: RequestApprovalInput): Promise<Approval> {
    const now = new Date().toISOString();
    const approval: Approval = {
      id: randomUUID(),
      tenantId: input.tenantId,
      agentId: input.agentId ?? null,
      agentRunId: input.agentRunId ?? null,
      requestedAction: input.requestedAction,
      payload: input.payload ?? {},
      riskLevel: input.riskLevel ?? "medium",
      status: "pending",
      requestedByType: input.requestedByType ?? "agent",
      requestedById: input.requestedById ?? null,
      approverUserId: null,
      reason: null,
      approvedAt: null,
      rejectedAt: null,
      expiresAt: input.expiresAt ?? null,
      executionResult: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(approval);
    return approval;
  }

  async decide(tenantId: string, id: string, input: DecideApprovalInput): Promise<Approval> {
    const existing = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (!existing) throw new Error(`approval ${id} not found for tenant ${tenantId}`);
    const now = new Date().toISOString();
    existing.status = input.status;
    existing.updatedAt = now;
    if (input.approverUserId !== undefined) existing.approverUserId = input.approverUserId;
    if (input.reason !== undefined) existing.reason = input.reason;
    if (input.executionResult !== undefined) existing.executionResult = input.executionResult;
    if (input.status === "approved") existing.approvedAt = now;
    if (input.status === "rejected") existing.rejectedAt = now;
    return existing;
  }

  async getById(tenantId: string, id: string): Promise<Approval | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.id === id) ?? null;
  }

  async listByTenant(tenantId: string, opts: { status?: ApprovalStatus } = {}): Promise<Approval[]> {
    return this.rows.filter((r) => r.tenantId === tenantId && (!opts.status || r.status === opts.status));
  }

  all(): Approval[] {
    return [...this.rows];
  }
}
