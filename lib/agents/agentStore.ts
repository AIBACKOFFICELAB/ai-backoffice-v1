import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Agent, AgentType, CreateAgentInput, UpdateAgentInput } from "./types";

export interface AgentStore {
  getById(tenantId: string, id: string): Promise<Agent | null>;
  listByTenant(tenantId: string, opts?: { agentType?: AgentType }): Promise<Agent[]>;
  create(input: CreateAgentInput): Promise<Agent>;
  update(tenantId: string, id: string, patch: UpdateAgentInput): Promise<Agent>;
}

function mapRow(row: Record<string, any>): Agent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentType: row.agent_type,
    name: row.name,
    purpose: row.purpose,
    status: row.status,
    allowedTools: row.allowed_tools ?? [],
    readScopes: row.read_scopes ?? [],
    writeScopes: row.write_scopes ?? [],
    approvalPolicy: row.approval_policy ?? {},
    modelPolicy: row.model_policy ?? {},
    systemInstructions: row.system_instructions,
    instructionsVersion: row.instructions_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SupabaseAgentStore implements AgentStore {
  async getById(tenantId: string, id: string): Promise<Agent | null> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("agents").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
    if (error || !data) return null;
    return mapRow(data);
  }

  async listByTenant(tenantId: string, opts: { agentType?: AgentType } = {}): Promise<Agent[]> {
    const supabase = await createServerSupabaseClient();
    let query = supabase.from("agents").select("*").eq("tenant_id", tenantId);
    if (opts.agentType) query = query.eq("agent_type", opts.agentType);
    const { data, error } = await query.order("created_at", { ascending: true });
    if (error) throw new Error(`[agents] list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }

  async create(input: CreateAgentInput): Promise<Agent> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("agents")
      .insert({
        tenant_id: input.tenantId,
        agent_type: input.agentType,
        name: input.name,
        purpose: input.purpose ?? null,
        status: input.status ?? "inactive",
        allowed_tools: input.allowedTools ?? [],
        read_scopes: input.readScopes ?? [],
        write_scopes: input.writeScopes ?? [],
        approval_policy: input.approvalPolicy ?? {},
        model_policy: input.modelPolicy ?? {},
        system_instructions: input.systemInstructions ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(`[agents] create failed: ${error.message}`);
    return mapRow(data);
  }

  async update(tenantId: string, id: string, patch: UpdateAgentInput): Promise<Agent> {
    const supabase = await createServerSupabaseClient();
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.purpose !== undefined) row.purpose = patch.purpose;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.allowedTools !== undefined) row.allowed_tools = patch.allowedTools;
    if (patch.readScopes !== undefined) row.read_scopes = patch.readScopes;
    if (patch.writeScopes !== undefined) row.write_scopes = patch.writeScopes;
    if (patch.approvalPolicy !== undefined) row.approval_policy = patch.approvalPolicy;
    if (patch.modelPolicy !== undefined) row.model_policy = patch.modelPolicy;
    if (patch.systemInstructions !== undefined) row.system_instructions = patch.systemInstructions;

    const { data, error } = await supabase.from("agents").update(row).eq("tenant_id", tenantId).eq("id", id).select().single();
    if (error) throw new Error(`[agents] update failed: ${error.message}`);
    return mapRow(data);
  }
}

export class InMemoryAgentStore implements AgentStore {
  private rows: Agent[] = [];

  async getById(tenantId: string, id: string): Promise<Agent | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.id === id) ?? null;
  }

  async listByTenant(tenantId: string, opts: { agentType?: AgentType } = {}): Promise<Agent[]> {
    return this.rows.filter((r) => r.tenantId === tenantId && (!opts.agentType || r.agentType === opts.agentType));
  }

  async create(input: CreateAgentInput): Promise<Agent> {
    const now = new Date().toISOString();
    const agent: Agent = {
      id: randomUUID(),
      tenantId: input.tenantId,
      agentType: input.agentType,
      name: input.name,
      purpose: input.purpose ?? null,
      status: input.status ?? "inactive",
      allowedTools: input.allowedTools ?? [],
      readScopes: input.readScopes ?? [],
      writeScopes: input.writeScopes ?? [],
      approvalPolicy: input.approvalPolicy ?? {},
      modelPolicy: input.modelPolicy ?? {},
      systemInstructions: input.systemInstructions ?? null,
      instructionsVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(agent);
    return agent;
  }

  async update(tenantId: string, id: string, patch: UpdateAgentInput): Promise<Agent> {
    const existing = await this.getById(tenantId, id);
    if (!existing) throw new Error(`agent ${id} not found for tenant ${tenantId}`);
    Object.assign(existing, patch, { updatedAt: new Date().toISOString() });
    return existing;
  }
}
