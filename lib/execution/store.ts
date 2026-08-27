import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DurableJob, EnqueueJobInput } from "./types";

export interface DurableJobStore {
  enqueue(input: EnqueueJobInput): Promise<{ job: DurableJob; deduped: boolean }>;
  /** Atomically claims up to `limit` due jobs for `workerId`. Uses a
   * compare-and-swap update (WHERE status='queued') so two concurrent
   * workers can never claim the same job — the Postgres-native equivalent
   * of `SELECT ... FOR UPDATE SKIP LOCKED` reachable through supabase-js. */
  claimBatch(workerId: string, limit?: number): Promise<DurableJob[]>;
  complete(tenantId: string, id: string): Promise<DurableJob>;
  fail(tenantId: string, id: string, errorMessage: string): Promise<DurableJob>;
  getById(tenantId: string, id: string): Promise<DurableJob | null>;
  listByTenant(tenantId: string, opts?: { status?: DurableJob["status"] }): Promise<DurableJob[]>;
}

function mapRow(row: Record<string, any>): DurableJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    jobType: row.job_type,
    payload: row.payload ?? {},
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    idempotencyKey: row.idempotency_key,
    correlationId: row.correlation_id,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    lockExpiresAt: row.lock_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/** Exponential backoff, capped at 1 hour: 60s, 120s, 240s, 480s, ... */
export function computeBackoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** (attempts - 1), 3600);
}

const UNIQUE_VIOLATION = "23505";

export class SupabaseDurableJobStore implements DurableJobStore {
  async enqueue(input: EnqueueJobInput): Promise<{ job: DurableJob; deduped: boolean }> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("durable_jobs")
      .insert({
        tenant_id: input.tenantId,
        job_type: input.jobType,
        payload: input.payload ?? {},
        max_attempts: input.maxAttempts ?? 5,
        idempotency_key: input.idempotencyKey ?? null,
        correlation_id: input.correlationId ?? null,
        next_attempt_at: input.runAt ?? undefined,
      })
      .select()
      .single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION && input.idempotencyKey) {
        const existing = await this.findByIdempotencyKey(input.tenantId, input.idempotencyKey);
        if (existing) return { job: existing, deduped: true };
      }
      throw new Error(`[durable_jobs] enqueue failed: ${error.message}`);
    }
    return { job: mapRow(data), deduped: false };
  }

  private async findByIdempotencyKey(tenantId: string, idempotencyKey: string): Promise<DurableJob | null> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("durable_jobs")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error || !data) return null;
    return mapRow(data);
  }

  async claimBatch(workerId: string, limit = 10): Promise<DurableJob[]> {
    const supabase = await createServerSupabaseClient();
    const nowIso = new Date().toISOString();

    const { data: candidates, error } = await supabase
      .from("durable_jobs")
      .select("id")
      .eq("status", "queued")
      .lte("next_attempt_at", nowIso)
      .order("next_attempt_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`[durable_jobs] claim query failed: ${error.message}`);

    const claimed: DurableJob[] = [];
    for (const candidate of candidates ?? []) {
      const { data: updated, error: updateError } = await supabase
        .from("durable_jobs")
        .update({ status: "running", locked_by: workerId, locked_at: nowIso, updated_at: nowIso })
        .eq("id", candidate.id)
        .eq("status", "queued") // compare-and-swap: only wins if still queued
        .select();
      if (updateError || !updated || updated.length !== 1) continue; // lost the race or transient error — leave for the next poll
      claimed.push(mapRow(updated[0]));
    }
    return claimed;
  }

  async complete(tenantId: string, id: string): Promise<DurableJob> {
    const supabase = await createServerSupabaseClient();
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("durable_jobs")
      .update({ status: "succeeded", completed_at: now, updated_at: now, locked_by: null, locked_at: null })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`[durable_jobs] complete failed: ${error.message}`);
    return mapRow(data);
  }

  async fail(tenantId: string, id: string, errorMessage: string): Promise<DurableJob> {
    const current = await this.getById(tenantId, id);
    if (!current) throw new Error(`durable_job ${id} not found for tenant ${tenantId}`);

    const attempts = current.attempts + 1;
    const exhausted = attempts >= current.maxAttempts;
    const nextAttemptAt = exhausted ? current.nextAttemptAt : new Date(Date.now() + computeBackoffSeconds(attempts) * 1000).toISOString();

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("durable_jobs")
      .update({
        status: exhausted ? "dead_letter" : "queued",
        attempts,
        last_error: errorMessage,
        next_attempt_at: nextAttemptAt,
        locked_by: null,
        locked_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`[durable_jobs] fail-transition failed: ${error.message}`);
    return mapRow(data);
  }

  async getById(tenantId: string, id: string): Promise<DurableJob | null> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.from("durable_jobs").select("*").eq("tenant_id", tenantId).eq("id", id).maybeSingle();
    if (error || !data) return null;
    return mapRow(data);
  }

  async listByTenant(tenantId: string, opts: { status?: DurableJob["status"] } = {}): Promise<DurableJob[]> {
    const supabase = await createServerSupabaseClient();
    let query = supabase.from("durable_jobs").select("*").eq("tenant_id", tenantId);
    if (opts.status) query = query.eq("status", opts.status);
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw new Error(`[durable_jobs] list failed: ${error.message}`);
    return (data ?? []).map(mapRow);
  }
}

export class InMemoryDurableJobStore implements DurableJobStore {
  private rows: DurableJob[] = [];

  async enqueue(input: EnqueueJobInput): Promise<{ job: DurableJob; deduped: boolean }> {
    if (input.idempotencyKey) {
      const existing = this.rows.find((r) => r.tenantId === input.tenantId && r.idempotencyKey === input.idempotencyKey);
      if (existing) return { job: existing, deduped: true };
    }
    const now = new Date().toISOString();
    const job: DurableJob = {
      id: randomUUID(),
      tenantId: input.tenantId,
      jobType: input.jobType,
      payload: input.payload ?? {},
      status: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      nextAttemptAt: input.runAt ?? now,
      lastError: null,
      idempotencyKey: input.idempotencyKey ?? null,
      correlationId: input.correlationId ?? null,
      lockedBy: null,
      lockedAt: null,
      lockExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.rows.push(job);
    return { job, deduped: false };
  }

  async claimBatch(workerId: string, limit = 10): Promise<DurableJob[]> {
    const nowIso = new Date().toISOString();
    const due = this.rows
      .filter((r) => r.status === "queued" && r.nextAttemptAt <= nowIso)
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
      .slice(0, limit);
    for (const job of due) {
      job.status = "running";
      job.lockedBy = workerId;
      job.lockedAt = nowIso;
      job.updatedAt = nowIso;
    }
    return due;
  }

  async complete(tenantId: string, id: string): Promise<DurableJob> {
    const job = this.mustGet(tenantId, id);
    job.status = "succeeded";
    job.completedAt = new Date().toISOString();
    job.lockedBy = null;
    job.lockedAt = null;
    return job;
  }

  async fail(tenantId: string, id: string, errorMessage: string): Promise<DurableJob> {
    const job = this.mustGet(tenantId, id);
    job.attempts += 1;
    const exhausted = job.attempts >= job.maxAttempts;
    job.status = exhausted ? "dead_letter" : "queued";
    job.lastError = errorMessage;
    if (!exhausted) job.nextAttemptAt = new Date(Date.now() + computeBackoffSeconds(job.attempts) * 1000).toISOString();
    job.lockedBy = null;
    job.lockedAt = null;
    job.updatedAt = new Date().toISOString();
    return job;
  }

  async getById(tenantId: string, id: string): Promise<DurableJob | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.id === id) ?? null;
  }

  async listByTenant(tenantId: string, opts: { status?: DurableJob["status"] } = {}): Promise<DurableJob[]> {
    return this.rows.filter((r) => r.tenantId === tenantId && (!opts.status || r.status === opts.status));
  }

  private mustGet(tenantId: string, id: string): DurableJob {
    const job = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (!job) throw new Error(`durable_job ${id} not found for tenant ${tenantId}`);
    return job;
  }

  all(): DurableJob[] {
    return [...this.rows];
  }
}
