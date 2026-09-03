import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { BusinessEvent, EmitEventInput } from "./types";

export interface BusinessEventStore {
  insert(input: EmitEventInput): Promise<{ event: BusinessEvent; deduped: boolean }>;
  /**
   * `causationIdIn`, when provided, restricts results to events whose
   * `causationId` is one of the given ids — e.g. "the review events caused
   * by these specific recommendation events" (see
   * lib/agents/estimateClosing/review.ts, which always sets `causationId`
   * to the recommendation event's own id). Added for a Codex finding on
   * PR #21: fetching a bounded set of events by RECENCY alone (`limit`)
   * and a bounded set of RELATED events independently can silently
   * mismatch — an older recommendation's review can crowd out a newer
   * recommendation's review from its own recency window even though the
   * newer recommendation itself is still in scope. `causationIdIn` lets a
   * caller ask the correct, narrower question directly instead. Mutually
   * exclusive with `limit` in practice (a caller passing `causationIdIn`
   * already has a natural bound — at most one review per recommendation,
   * by idempotency — so no separate `limit` is needed); both may be
   * combined but `limit` still applies to the reduced set if so.
   */
  /**
   * `offset`, when provided alongside `limit`, pages through results —
   * added so a caller needing an EXHAUSTIVE read across more rows than any
   * single bounded `limit` can safely request (e.g.
   * lib/agents/estimateClosing/commercialEvidence.ts's
   * fetchFollowThroughEventsForRecommendations, which must not silently
   * truncate a tenant's accumulated follow-through corrections) can request
   * successive pages instead. Ordering is always STABLE — `occurred_at`
   * DESC, `id` DESC as a tiebreaker for rows sharing the same
   * `occurred_at` — specifically so paging never skips or duplicates a row
   * at a page boundary (see both implementations below).
   */
  listByTenant(tenantId: string, opts?: { eventType?: string; limit?: number; offset?: number; causationIdIn?: string[] }): Promise<BusinessEvent[]>;
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

  async listByTenant(tenantId: string, opts: { eventType?: string; limit?: number; offset?: number; causationIdIn?: string[] } = {}): Promise<BusinessEvent[]> {
    const supabase = await createServerSupabaseClient();
    let query = supabase.from("business_events").select("*").eq("tenant_id", tenantId);
    if (opts.eventType) query = query.eq("event_type", opts.eventType);
    if (opts.causationIdIn) {
      if (opts.causationIdIn.length === 0) return [];
      query = query.in("causation_id", opts.causationIdIn);
    }
    // Default limit is 50 for a plain recency read; a causationIdIn read's
    // own natural bound is the size of that id set (it can never match
    // more rows than that) unless the caller narrows further. Secondary
    // `id` DESC ordering is a stable tiebreaker — required for `offset`
    // paging to be gap/duplicate-free across pages when multiple rows
    // share an identical `occurred_at` (see the interface's own doc
    // comment).
    query = query.order("occurred_at", { ascending: false }).order("id", { ascending: false });
    const limit = opts.limit ?? opts.causationIdIn?.length ?? 50;
    query = opts.offset != null ? query.range(opts.offset, opts.offset + limit - 1) : query.limit(limit);
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

  async listByTenant(tenantId: string, opts: { eventType?: string; limit?: number; offset?: number; causationIdIn?: string[] } = {}): Promise<BusinessEvent[]> {
    if (opts.causationIdIn && opts.causationIdIn.length === 0) return [];
    const causationIdSet = opts.causationIdIn ? new Set(opts.causationIdIn) : null;
    const matched = this.rows
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          (!opts.eventType || r.eventType === opts.eventType) &&
          (!causationIdSet || (r.causationId !== null && causationIdSet.has(r.causationId)))
      )
      // Same stable (occurredAt DESC, id DESC) ordering the Supabase store
      // uses — required for offset-based paging to be gap/duplicate-free
      // when rows share an identical occurredAt (a real possibility with
      // this store's own millisecond-resolution default clock).
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
    const limit = opts.limit ?? causationIdSet?.size ?? 50;
    const offset = opts.offset ?? 0;
    return matched.slice(offset, offset + limit);
  }

  async getById(tenantId: string, id: string): Promise<BusinessEvent | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.id === id) ?? null;
  }

  /** Test/dev helper — not part of the interface. */
  all(): BusinessEvent[] {
    return [...this.rows];
  }
}
