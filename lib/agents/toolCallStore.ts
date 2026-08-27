import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type ToolCallStatus = "pending" | "succeeded" | "failed" | "requires_approval" | "denied";

export type ToolCall = {
  id: string;
  tenantId: string;
  agentRunId: string;
  toolName: string;
  action: string;
  requestSummary: Record<string, unknown>;
  responseSummary: Record<string, unknown> | null;
  status: ToolCallStatus;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  requiresApproval: boolean;
  approvalId: string | null;
  createdAt: string;
};

export type CreateToolCallInput = {
  tenantId: string;
  agentRunId: string;
  toolName: string;
  action: string;
  requestSummary: Record<string, unknown>;
  requiresApproval?: boolean;
};

export type UpdateToolCallInput = Partial<
  Pick<ToolCall, "status" | "responseSummary" | "completedAt" | "error" | "requiresApproval" | "approvalId">
>;

export interface ToolCallStore {
  create(input: CreateToolCallInput): Promise<ToolCall>;
  update(tenantId: string, id: string, patch: UpdateToolCallInput): Promise<ToolCall>;
  listByAgentRun(tenantId: string, agentRunId: string): Promise<ToolCall[]>;
  getByApprovalId(tenantId: string, approvalId: string): Promise<ToolCall | null>;
}

function mapRow(row: Record<string, any>): ToolCall {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentRunId: row.agent_run_id,
    toolName: row.tool_name,
    action: row.action,
    requestSummary: row.request_summary ?? {},
    responseSummary: row.response_summary,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    requiresApproval: row.requires_approval,
    approvalId: row.approval_id,
    createdAt: row.created_at,
  };
}

export class SupabaseToolCallStore implements ToolCallStore {
  async create(input: CreateToolCallInput): Promise<ToolCall> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("tool_calls")
      .insert({
        tenant_id: input.tenantId,
        agent_run_id: input.agentRunId,
        tool_name: input.toolName,
        action: input.action,
        request_summary: input.requestSummary,
        requires_approval: input.requiresApproval ?? false,
        status: "pending",
      })
      .select()
      .single();
    if (error) throw new Error(`[tool_calls] create failed: ${error.message}`);
    return mapRow(data);
  }

  async update(tenantId: string, id: string, patch: UpdateToolCallInput): Promise<ToolCall> {
    const supabase = await createServerSupabaseClient();
    const row: Record<string, unknown> = {};
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.responseSummary !== undefined) row.response_summary = patch.responseSummary;
    if (patch.completedAt !== undefined) row.completed_at = patch.completedAt;
    if (patch.error !== undefined) row.error = patch.error;
    if (patch.requiresApproval !== undefined) row.requires_approval = patch.requiresApproval;
    if (patch.approvalId !== undefined) row.approval_id = patch.approvalId;

    const { data, error } = await supabase.from("tool_calls").update(row).eq("tenant_id", tenantId).eq("id", id).select().single();
    if (error) throw new Error(`[tool_calls] update failed: ${error.message}`);
    return mapRow(data);
  }

  async listByAgentRun(tenantId: string, agentRunId: string): Promise<ToolCall[]> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("tool_calls")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("agent_run_id", agentRunId)
      .order("started_at", { ascending: true });
    if (error) throw new Error(`[tool_calls] list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }

  async getByApprovalId(tenantId: string, approvalId: string): Promise<ToolCall | null> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("tool_calls").select("*").eq("tenant_id", tenantId).eq("approval_id", approvalId).maybeSingle();
    if (error || !data) return null;
    return mapRow(data);
  }
}

export class InMemoryToolCallStore implements ToolCallStore {
  private rows: ToolCall[] = [];

  async create(input: CreateToolCallInput): Promise<ToolCall> {
    const now = new Date().toISOString();
    const toolCall: ToolCall = {
      id: randomUUID(),
      tenantId: input.tenantId,
      agentRunId: input.agentRunId,
      toolName: input.toolName,
      action: input.action,
      requestSummary: input.requestSummary,
      responseSummary: null,
      status: "pending",
      startedAt: now,
      completedAt: null,
      error: null,
      requiresApproval: input.requiresApproval ?? false,
      approvalId: null,
      createdAt: now,
    };
    this.rows.push(toolCall);
    return toolCall;
  }

  async update(tenantId: string, id: string, patch: UpdateToolCallInput): Promise<ToolCall> {
    const existing = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (!existing) throw new Error(`tool_call ${id} not found for tenant ${tenantId}`);
    Object.assign(existing, patch);
    return existing;
  }

  async listByAgentRun(tenantId: string, agentRunId: string): Promise<ToolCall[]> {
    return this.rows.filter((r) => r.tenantId === tenantId && r.agentRunId === agentRunId);
  }

  async getByApprovalId(tenantId: string, approvalId: string): Promise<ToolCall | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.approvalId === approvalId) ?? null;
  }

  all(): ToolCall[] {
    return [...this.rows];
  }
}
