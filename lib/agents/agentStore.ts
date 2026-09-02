import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Agent, AgentType, CreateAgentInput, UpdateAgentInput } from "./types";

const UNIQUE_VIOLATION = "23505";

export interface AgentStore {
  getById(tenantId: string, id: string): Promise<Agent | null>;
  listByTenant(tenantId: string, opts?: { agentType?: AgentType }): Promise<Agent[]>;
  create(input: CreateAgentInput): Promise<Agent>;
  update(tenantId: string, id: string, patch: UpdateAgentInput): Promise<Agent>;
  /** The one row for this tenant + built-in agent_type, if any. Meaningful
   * only for non-'custom' types — see migration 017's
   * uq_agents_tenant_builtin_type partial unique index, which is the
   * actual guarantee at most one such row can ever exist. */
  findByBuiltinType(tenantId: string, agentType: AgentType): Promise<Agent | null>;
  /**
   * Idempotent creation (Codex P0 audit finding M-03): for any
   * agentType !== 'custom', at most one row is ever created per
   * (tenantId, agentType) — concurrent callers racing this method will see
   * exactly one winner; the loser(s) get `created: false` and the winner's
   * row back, never a duplicate and never an error. Relies on the database
   * uniqueness constraint (migration 017) as the actual guarantee, not on
   * an application-level list-then-insert check (which has an inherent
   * race — the defect this replaces). 'custom' agents always create a new
   * row, since multiple custom agents per tenant must remain possible.
   */
  createIfAbsent(input: CreateAgentInput): Promise<{ agent: Agent; created: boolean }>;
  /**
   * P1 Sprint 5 — the ONE cross-tenant, unfiltered-by-tenant read in this
   * store. Deliberately mirrors the same trust boundary
   * lib/modules/estimateFollowup/service.ts::processDueFollowups() already
   * uses for its own cron (a service-role query with no `.eq("tenant_id",
   * ...)` filter, because the caller genuinely needs every tenant's rows —
   * see that function's own doc comment). Exists so the Estimate Closing
   * scan telemetry (lib/agents/estimateClosing/scanTelemetry.ts) can
   * identify which tenants are "relevant" (registered AND active — the
   * exact same criterion shadowRunner.ts's own per-candidate gate already
   * requires before any model call) WITHOUT hardcoding a tenant id or
   * inventing a fake "global tenant." Never used by any per-tenant page or
   * API route — every other caller in this codebase remains tenant-scoped.
   */
  listActiveByType(agentType: AgentType): Promise<Agent[]>;
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

function toInsertRow(input: CreateAgentInput) {
  return {
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

  async findByBuiltinType(tenantId: string, agentType: AgentType): Promise<Agent | null> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("agents").select("*").eq("tenant_id", tenantId).eq("agent_type", agentType).maybeSingle();
    if (error || !data) return null;
    return mapRow(data);
  }

  async create(input: CreateAgentInput): Promise<Agent> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("agents").insert(toInsertRow(input)).select().single();
    if (error) throw new Error(`[agents] create failed: ${error.message}`);
    return mapRow(data);
  }

  async createIfAbsent(input: CreateAgentInput): Promise<{ agent: Agent; created: boolean }> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("agents").insert(toInsertRow(input)).select().single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION && input.agentType !== "custom") {
        const existing = await this.findByBuiltinType(input.tenantId, input.agentType);
        if (existing) return { agent: existing, created: false };
      }
      throw new Error(`[agents] createIfAbsent failed: ${error.message}`);
    }
    return { agent: mapRow(data), created: true };
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
    if (patch.systemInstructions !== undefined) {
      row.system_instructions = patch.systemInstructions;
      // P0.9 Slice B correction 3: advance the human-readable version
      // counter only when systemInstructions actually CHANGES VALUE — not
      // merely because it's present in the patch, and never for an
      // unrelated-field update. Best-effort / non-atomic: this is a
      // read-then-write, so two concurrent updates to the SAME agent's
      // instructions could under-count by one. That's an accepted,
      // documented limitation for P0.9 — the immutable, per-decision
      // agentInstructionsHash on PolicySnapshot (see
      // lib/agents/permissions.ts::hashInstructions) is the authoritative
      // historical identity, not this counter.
      const current = await this.getById(tenantId, id);
      if (current && current.systemInstructions !== patch.systemInstructions) {
        row.instructions_version = current.instructionsVersion + 1;
      }
    }

    const { data, error } = await supabase.from("agents").update(row).eq("tenant_id", tenantId).eq("id", id).select().single();
    if (error) throw new Error(`[agents] update failed: ${error.message}`);
    return mapRow(data);
  }

  async listActiveByType(agentType: AgentType): Promise<Agent[]> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("agents").select("*").eq("agent_type", agentType).eq("status", "active");
    if (error) throw new Error(`[agents] listActiveByType failed: ${error.message}`);
    return (data ?? []).map(mapRow);
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

  async findByBuiltinType(tenantId: string, agentType: AgentType): Promise<Agent | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.agentType === agentType) ?? null;
  }

  /** Enforces the same uniqueness rule migration 017's
   * uq_agents_tenant_builtin_type partial index enforces in production —
   * this is what lets tests exercise createIfAbsent's conflict-handling
   * path without a live database. The check-then-push below is
   * DELIBERATELY synchronous (no `await` between them, unlike
   * findByBuiltinType which is only for post-conflict lookups) — an
   * `await` here would reopen exactly the TOCTOU race this method exists
   * to close, since two "concurrent" callers could both pass the check
   * before either pushes. See lib/agents/seed.test.ts. */
  async create(input: CreateAgentInput): Promise<Agent> {
    const conflicts = input.agentType !== "custom" && this.rows.some((r) => r.tenantId === input.tenantId && r.agentType === input.agentType);
    if (conflicts) {
      const conflict: Error & { code?: string } = new Error(
        `duplicate key value violates unique constraint "uq_agents_tenant_builtin_type"`
      );
      conflict.code = UNIQUE_VIOLATION;
      throw conflict;
    }
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

  async createIfAbsent(input: CreateAgentInput): Promise<{ agent: Agent; created: boolean }> {
    try {
      return { agent: await this.create(input), created: true };
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === UNIQUE_VIOLATION && input.agentType !== "custom") {
        const existing = await this.findByBuiltinType(input.tenantId, input.agentType);
        if (existing) return { agent: existing, created: false };
      }
      throw error;
    }
  }

  async update(tenantId: string, id: string, patch: UpdateAgentInput): Promise<Agent> {
    const existing = await this.getById(tenantId, id);
    if (!existing) throw new Error(`agent ${id} not found for tenant ${tenantId}`);
    // P0.9 Slice B correction 3: mirror the Supabase store's rule exactly —
    // advance instructionsVersion only when systemInstructions is present
    // in the patch AND actually differs from the current value. Read the
    // pre-patch value BEFORE Object.assign below overwrites it.
    if (patch.systemInstructions !== undefined && patch.systemInstructions !== existing.systemInstructions) {
      existing.instructionsVersion += 1;
    }
    Object.assign(existing, patch, { updatedAt: new Date().toISOString() });
    return existing;
  }

  async listActiveByType(agentType: AgentType): Promise<Agent[]> {
    return this.rows.filter((r) => r.agentType === agentType && r.status === "active");
  }
}
