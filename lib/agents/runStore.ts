import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type AgentRunStatus = "pending" | "running" | "awaiting_approval" | "succeeded" | "failed" | "cancelled";

export type AgentRun = {
  id: string;
  tenantId: string;
  agentId: string;
  triggerEventId: string | null;
  workflowId: string | null;
  status: AgentRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  modelStrategy: Record<string, unknown>;
  inputContextRef: string | null;
  outputSummary: string | null;
  failureReason: string | null;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateAgentRunInput = {
  tenantId: string;
  agentId: string;
  triggerEventId?: string | null;
  workflowId?: string | null;
  inputContextRef?: string | null;
  correlationId?: string;
};

export type UpdateAgentRunInput = Partial<
  Pick<AgentRun, "status" | "startedAt" | "completedAt" | "modelStrategy" | "outputSummary" | "failureReason">
>;

export interface AgentRunStore {
  create(input: CreateAgentRunInput): Promise<AgentRun>;
  update(tenantId: string, id: string, patch: UpdateAgentRunInput): Promise<AgentRun>;
  getById(tenantId: string, id: string): Promise<AgentRun | null>;
  listByTenant(tenantId: string, opts?: { limit?: number }): Promise<AgentRun[]>;
}

function mapRow(row: Record<string, any>): AgentRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    triggerEventId: row.trigger_event_id,
    workflowId: row.workflow_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    modelStrategy: row.model_strategy ?? {},
    inputContextRef: row.input_context_ref,
    outputSummary: row.output_summary,
    failureReason: row.failure_reason,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SupabaseAgentRunStore implements AgentRunStore {
  async create(input: CreateAgentRunInput): Promise<AgentRun> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("agent_runs")
      .insert({
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        trigger_event_id: input.triggerEventId ?? null,
        workflow_id: input.workflowId ?? null,
        input_context_ref: input.inputContextRef ?? null,
        correlation_id: input.correlationId ?? undefined,
        status: "pending",
      })
      .select()
      .single();
    if (error) throw new Error(`[agent_runs] create failed: ${error.message}`);
    return mapRow(data);
  }

  async update(tenantId: string, id: string, patch: UpdateAgentRunInput): Promise<AgentRun> {
    const supabase = await createServerSupabaseClient();
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.startedAt !== undefined) row.started_at = patch.startedAt;
    if (patch.completedAt !== undefined) row.completed_at = patch.completedAt;
    if (patch.modelStrategy !== undefined) row.model_strategy = patch.modelStrategy;
    if (patch.outputSummary !== undefined) row.output_summary = patch.outputSummary;
    if (patch.failureReason !== undefined) row.failure_reason = patch.failureReason;

    const { data, error } = await supabase.from("agent_runs").update(row).eq("tenant_id", tenantId).eq("id", id).select().single();
    if (error) throw new Error(`[agent_runs] update failed: ${error.message}`);
    return mapRow(data);
  }

  async getById(tenantId: string, id: string): Promise<AgentRun | null> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("agent_runs").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
    if (error || !data) return null;
    return mapRow(data);
  }

  async listByTenant(tenantId: string, opts: { limit?: number } = {}): Promise<AgentRun[]> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("agent_runs")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(opts.limit ?? 50);
    if (error) throw new Error(`[agent_runs] list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }
}

export class InMemoryAgentRunStore implements AgentRunStore {
  private rows: AgentRun[] = [];

  async create(input: CreateAgentRunInput): Promise<AgentRun> {
    const now = new Date().toISOString();
    const run: AgentRun = {
      id: randomUUID(),
      tenantId: input.tenantId,
      agentId: input.agentId,
      triggerEventId: input.triggerEventId ?? null,
      workflowId: input.workflowId ?? null,
      status: "pending",
      startedAt: null,
      completedAt: null,
      modelStrategy: {},
      inputContextRef: input.inputContextRef ?? null,
      outputSummary: null,
      failureReason: null,
      correlationId: input.correlationId ?? randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(run);
    return run;
  }

  async update(tenantId: string, id: string, patch: UpdateAgentRunInput): Promise<AgentRun> {
    const existing = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (!existing) throw new Error(`agent_run ${id} not found for tenant ${tenantId}`);
    Object.assign(existing, patch, { updatedAt: new Date().toISOString() });
    return existing;
  }

  async getById(tenantId: string, id: string): Promise<AgentRun | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.id === id) ?? null;
  }

  async listByTenant(tenantId: string, opts: { limit?: number } = {}): Promise<AgentRun[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, opts.limit ?? 50);
  }

  all(): AgentRun[] {
    return [...this.rows];
  }
}
