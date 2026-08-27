import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Outcome, OutcomeType, RecordOutcomeInput } from "./types";

export interface OutcomeStore {
  insert(input: RecordOutcomeInput): Promise<Outcome>;
  listByTenant(tenantId: string, opts?: { outcomeType?: OutcomeType; limit?: number }): Promise<Outcome[]>;
}

function mapRow(row: Record<string, any>): Outcome {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    agentRunId: row.agent_run_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    outcomeType: row.outcome_type,
    outcomeValue: row.outcome_value === null ? null : Number(row.outcome_value),
    currency: row.currency,
    attributionConfidence: row.attribution_confidence,
    occurredAt: row.occurred_at,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

export class SupabaseOutcomeStore implements OutcomeStore {
  async insert(input: RecordOutcomeInput): Promise<Outcome> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("outcomes")
      .insert({
        tenant_id: input.tenantId,
        workflow_id: input.workflowId ?? null,
        agent_run_id: input.agentRunId ?? null,
        entity_type: input.entityType ?? null,
        entity_id: input.entityId ?? null,
        outcome_type: input.outcomeType,
        outcome_value: input.outcomeValue ?? null,
        currency: input.currency ?? "USD",
        attribution_confidence: input.attributionConfidence,
        occurred_at: input.occurredAt ?? undefined,
        metadata: input.metadata ?? {},
      })
      .select()
      .single();
    if (error) throw new Error(`[outcomes] insert failed: ${error.message}`);
    return mapRow(data);
  }

  async listByTenant(tenantId: string, opts: { outcomeType?: OutcomeType; limit?: number } = {}): Promise<Outcome[]> {
    const supabase = await createServerSupabaseClient();
    let query = supabase.from("outcomes").select("*").eq("tenant_id", tenantId);
    if (opts.outcomeType) query = query.eq("outcome_type", opts.outcomeType);
    query = query.order("occurred_at", { ascending: false }).limit(opts.limit ?? 50);
    const { data, error } = await query;
    if (error) throw new Error(`[outcomes] list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }
}

export class InMemoryOutcomeStore implements OutcomeStore {
  private rows: Outcome[] = [];

  async insert(input: RecordOutcomeInput): Promise<Outcome> {
    const now = new Date().toISOString();
    const outcome: Outcome = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workflowId: input.workflowId ?? null,
      agentRunId: input.agentRunId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      outcomeType: input.outcomeType,
      outcomeValue: input.outcomeValue ?? null,
      currency: input.currency ?? "USD",
      attributionConfidence: input.attributionConfidence,
      occurredAt: input.occurredAt ?? now,
      metadata: input.metadata ?? {},
      createdAt: now,
    };
    this.rows.push(outcome);
    return outcome;
  }

  async listByTenant(tenantId: string, opts: { outcomeType?: OutcomeType; limit?: number } = {}): Promise<Outcome[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && (!opts.outcomeType || r.outcomeType === opts.outcomeType))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, opts.limit ?? 50);
  }

  all(): Outcome[] {
    return [...this.rows];
  }
}
