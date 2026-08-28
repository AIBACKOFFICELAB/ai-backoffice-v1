import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Outcome, OutcomeType, RecordOutcomeInput } from "./types";

export interface OutcomeStore {
  /** Idempotent when `idempotencyKey` is provided (P0.9 Slice C, finding
   * C.3): a repeated webhook, event replay, retry, or compatibility
   * callback for the SAME (tenantId, idempotencyKey) returns the
   * ORIGINAL outcome (`deduped: true`) rather than creating a duplicate —
   * mirrors lib/events/store.ts and lib/execution/store.ts exactly. */
  insert(input: RecordOutcomeInput): Promise<{ outcome: Outcome; deduped: boolean }>;
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
    idempotencyKey: row.idempotency_key ?? null,
    createdAt: row.created_at,
  };
}

const UNIQUE_VIOLATION = "23505";

export class SupabaseOutcomeStore implements OutcomeStore {
  async insert(input: RecordOutcomeInput): Promise<{ outcome: Outcome; deduped: boolean }> {
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
        idempotency_key: input.idempotencyKey ?? null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION && input.idempotencyKey) {
        const existing = await this.findByIdempotencyKey(input.tenantId, input.idempotencyKey);
        if (existing) return { outcome: existing, deduped: true };
      }
      throw new Error(`[outcomes] insert failed: ${error.message}`);
    }
    return { outcome: mapRow(data), deduped: false };
  }

  private async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<Outcome | null> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("outcomes")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error || !data) return null;
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

  async insert(input: RecordOutcomeInput): Promise<{ outcome: Outcome; deduped: boolean }> {
    if (input.idempotencyKey) {
      const existing = this.rows.find((r) => r.tenantId === input.tenantId && r.idempotencyKey === input.idempotencyKey);
      if (existing) return { outcome: existing, deduped: true };
    }
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
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now,
    };
    this.rows.push(outcome);
    return { outcome, deduped: false };
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
