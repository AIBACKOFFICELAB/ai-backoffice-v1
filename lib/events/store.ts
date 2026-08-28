import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { BusinessEvent, EmitEventInput } from "./types";

export interface BusinessEventStore {
  insert(input: EmitEventInput): Promise<{ event: BusinessEvent; deduped: boolean }>;
  listByTenant(tenantId: string, opts?: { eventType?: string; limit?: number }): Promise<BusinessEvent[]>;
  getById(tenantId: string, id: string): Promise<BusinessEvent | null>;
}

function mapRow(row: Record<string, any>): BusinessEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload ?? {},
    metadata: row.metadata ?? {},
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

const UNIQUE_VIOLATION = "23505";

/** Supabase-backed store. Uses the service-role client and always filters by
 * tenant_id explicitly — RLS is present as a backstop, not the enforcement
 * mechanism (see docs/constitution/06_DATABASE_PRINCIPLES.md and
 * docs/AGENT_SECURITY.md). */
export class SupabaseBusinessEventStore implements BusinessEventStore {
  async insert(input: EmitEventInput): Promise<{ event: BusinessEvent; deduped: boolean }> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("business_events")
      .insert({
        tenant_id: input.tenantId,
        event_type: input.eventType,
        actor_type: input.actorType ?? "system",
        actor_id: input.actorId ?? null,
        entity_type: input.entityType ?? null,
        entity_id: input.entityId ?? null,
        correlation_id: input.correlationId ?? undefined,
        causation_id: input.causationId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        payload: input.payload ?? {},
        metadata: input.metadata ?? {},
        occurred_at: input.occurredAt ?? undefined,
      })
      .select()
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION && input.idempotencyKey) {
        const existing = await this.findByIdempotencyKey(input.tenantId, input.idempotencyKey);
        if (existing) return { event: existing, deduped: true };
      }
      throw new Error(`[business_events] insert failed: ${error.message}`);
    }

    return { event: mapRow(data), deduped: false };
  }

  private async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<BusinessEvent | null> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("business_events")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error || !data) return null;
    return mapRow(data);
  }

  async listByTenant(tenantId: string, opts: { eventType?: string; limit?: number } = {}): Promise<BusinessEvent[]> {
    const supabase = await createServerSupabaseClient();
    let query = supabase.from("business_events").select("*").eq("tenant_id", tenantId);
    if (opts.eventType) query = query.eq("event_type", opts.eventType);
    query = query.order("occurred_at", { ascending: false }).limit(opts.limit ?? 50);
    const { data, error } = await query;
    if (error) throw new Error(`[business_events] list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }

  async getById(tenantId: string, id: string): Promise<BusinessEvent | null> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("business_events").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
    if (error || !data) return null;
    return mapRow(data);
  }
}

/** In-memory fake used by tests and safe to use in scripts/dev tooling that
 * shouldn't touch the live database. Mirrors the unique-index-based
 * idempotency the real table enforces. */
export class InMemoryBusinessEventStore implements BusinessEventStore {
  private rows: BusinessEvent[] = [];

  async insert(input: EmitEventInput): Promise<{ event: BusinessEvent; deduped: boolean }> {
    if (input.idempotencyKey) {
      const existing = this.rows.find((r) => r.tenantId === input.tenantId && r.idempotencyKey === input.idempotencyKey);
      if (existing) return { event: existing, deduped: true };
    }
    const now = new Date().toISOString();
    const event: BusinessEvent = {
      id: randomUUID(),
      tenantId: input.tenantId,
      eventType: input.eventType,
      actorType: input.actorType ?? "system",
      actorId: input.actorId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      correlationId: input.correlationId ?? randomUUID(),
      causationId: input.causationId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      payload: input.payload ?? {},
      metadata: input.metadata ?? {},
      occurredAt: input.occurredAt ?? now,
      createdAt: now,
    };
    this.rows.push(event);
    return { event, deduped: false };
  }

  async listByTenant(tenantId: string, opts: { eventType?: string; limit?: number } = {}): Promise<BusinessEvent[]> {
    return this.rows
      .filter((r) => r.tenantId === tenantId && (!opts.eventType || r.eventType === opts.eventType))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, opts.limit ?? 50);
  }

  async getById(tenantId: string, id: string): Promise<BusinessEvent | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.id === id) ?? null;
  }

  /** Test/dev helper — not part of the interface. */
  all(): BusinessEvent[] {
    return [...this.rows];
  }
}
