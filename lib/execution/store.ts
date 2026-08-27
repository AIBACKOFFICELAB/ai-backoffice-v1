import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DurableJob, EnqueueJobInput, DEFAULT_LEASE_DURATION_SECONDS } from "./types";

/**
 * Durable job store (P0.6, hardened P0.9 Slice B — findings H-02, B.1-B.4,
 * B.6). Every state transition below is a compare-and-swap: an UPDATE whose
 * WHERE clause encodes the exact precondition being asserted, followed by a
 * row-count check. Zero rows updated always means "lost the race / lease
 * superseded / already terminal" — returned as `null`, never thrown. This is
 * the same CAS discipline used throughout P0.9 (see
 * lib/approvals/store.ts::beginExecution/decide).
 */
export interface DurableJobStore {
  enqueue(input: EnqueueJobInput): Promise<{ job: DurableJob; deduped: boolean }>;
  /**
   * Atomically claims up to `limit` due jobs for `workerId`. Two things can
   * make a job "due": it's `queued` and its `next_attempt_at` has passed, or
   * it's `running` but its `lock_expires_at` has passed (its previous
   * worker presumably crashed — B.2 reclaim). Each candidate is claimed via
   * its own CAS update; a candidate already at `max_attempts` on the
   * reclaim path is swept straight to `dead_letter` instead of being
   * reclaimed (B.2's documented attempt-counting rule — see the `attempts`
   * field's doc comment in types.ts: attempts is incremented HERE, at
   * claim/reclaim time, not at fail() time, so a job whose worker keeps
   * crashing without ever calling fail() still converges on
   * `max_attempts`).
   */
  claimBatch(workerId: string, limit?: number): Promise<DurableJob[]>;
  /** Requires proof of ownership: tenant, job id, status='running', AND the
   * exact lease token this worker was issued at claim time (B.3). Returns
   * null — never throws — if that lease is no longer the active one. */
  complete(tenantId: string, id: string, leaseToken: string): Promise<DurableJob | null>;
  fail(tenantId: string, id: string, errorMessage: string, leaseToken: string): Promise<DurableJob | null>;
  /** Extends an active lease. Requires the same ownership proof as
   * complete/fail (B.4) — a stale or incorrect worker's heartbeat is
   * refused (returns null), it can never extend someone else's lease. */
  renewLease(tenantId: string, id: string, leaseToken: string, extendBySeconds?: number): Promise<DurableJob | null>;
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
    leaseToken: row.lease_token ?? null,
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

    // A candidate is due either because it's freshly queued, or because a
    // previous worker's lease on it has expired (B.2 reclaim).
    const { data: candidates, error } = await supabase
      .from("durable_jobs")
      .select("id, status, attempts, max_attempts")
      .or(`and(status.eq.queued,next_attempt_at.lte.${nowIso}),and(status.eq.running,lock_expires_at.lte.${nowIso})`)
      .order("next_attempt_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`[durable_jobs] claim query failed: ${error.message}`);

    const claimed: DurableJob[] = [];
    for (const candidate of candidates ?? []) {
      const isReclaim = candidate.status === "running";

      if (isReclaim && candidate.attempts >= candidate.max_attempts) {
        // Already at the attempt ceiling — sweep straight to dead_letter
        // instead of reclaiming for another doomed attempt. Still a CAS,
        // re-checking lock_expires_at so a heartbeat that renewed the lease
        // between the select above and this update is never overridden.
        await supabase
          .from("durable_jobs")
          .update({
            status: "dead_letter",
            last_error: "exceeded max_attempts after repeated crash/reclaim without an explicit fail()",
            locked_by: null,
            locked_at: null,
            lock_expires_at: null,
            lease_token: null,
            updated_at: nowIso,
          })
          .eq("id", candidate.id)
          .eq("status", "running")
          .lte("lock_expires_at", nowIso)
          .select();
        // Whether this worker won the sweep or lost it to someone else,
        // the row is not this worker's to process — never add it to
        // `claimed` either way.
        continue;
      }

      const nextAttempts = candidate.attempts + 1;
      const leaseToken = randomUUID();
      let query = supabase
        .from("durable_jobs")
        .update({
          status: "running",
          locked_by: workerId,
          locked_at: nowIso,
          lock_expires_at: new Date(Date.now() + DEFAULT_LEASE_DURATION_SECONDS * 1000).toISOString(),
          lease_token: leaseToken,
          attempts: nextAttempts,
          updated_at: nowIso,
        })
        .eq("id", candidate.id)
        .eq("status", candidate.status)
        .eq("attempts", candidate.attempts); // re-verify attempts hasn't moved since the select

      // Re-check the exact condition that made this candidate due, closing
      // the TOCTOU gap between the select above and this update: a queued
      // job must still be due; a running job's lease must still be expired
      // (a heartbeat renewing it in between must never be overridden).
      query = isReclaim ? query.lte("lock_expires_at", nowIso) : query.lte("next_attempt_at", nowIso);

      const { data: updated, error: updateError } = await query.select();
      if (updateError || !updated || updated.length !== 1) continue; // lost the race — leave for the next poll
      claimed.push(mapRow(updated[0]));
    }
    return claimed;
  }

  async complete(tenantId: string, id: string, leaseToken: string): Promise<DurableJob | null> {
    const supabase = await createServerSupabaseClient();
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("durable_jobs")
      .update({ status: "succeeded", completed_at: now, updated_at: now, locked_by: null, locked_at: null, lock_expires_at: null })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .eq("status", "running")
      .eq("lease_token", leaseToken)
      .select();
    if (error) throw new Error(`[durable_jobs] complete failed: ${error.message}`);
    if (!data || data.length !== 1) return null; // lease superseded, already terminal, or never owned by this caller
    return mapRow(data[0]);
  }

  async fail(tenantId: string, id: string, errorMessage: string, leaseToken: string): Promise<DurableJob | null> {
    // Advisory pre-read only, to compute the backoff/exhaustion decision —
    // the actual transition below is still a CAS keyed on the lease token,
    // so a lease lost between this read and the write below correctly
    // fails the update rather than corrupting state (attempts itself is
    // never written here — see the attempts field's doc comment in
    // types.ts; it can only move while this worker holds the very lease
    // this call's WHERE clause requires, so it cannot have changed unless
    // the lease already moved on, in which case the CAS below no-ops).
    const current = await this.getById(tenantId, id);
    if (!current) return null;

    const exhausted = current.attempts >= current.maxAttempts;
    const nextAttemptAt = exhausted ? current.nextAttemptAt : new Date(Date.now() + computeBackoffSeconds(current.attempts) * 1000).toISOString();

    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("durable_jobs")
      .update({
        status: exhausted ? "dead_letter" : "queued",
        last_error: errorMessage,
        next_attempt_at: nextAttemptAt,
        locked_by: null,
        locked_at: null,
        lock_expires_at: null,
        lease_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .eq("status", "running")
      .eq("lease_token", leaseToken)
      .select();
    if (error) throw new Error(`[durable_jobs] fail-transition failed: ${error.message}`);
    if (!data || data.length !== 1) return null;
    return mapRow(data[0]);
  }

  async renewLease(tenantId: string, id: string, leaseToken: string, extendBySeconds = DEFAULT_LEASE_DURATION_SECONDS): Promise<DurableJob | null> {
    const supabase = await createServerSupabaseClient();
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("durable_jobs")
      .update({ lock_expires_at: new Date(Date.now() + extendBySeconds * 1000).toISOString(), updated_at: now })
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .eq("status", "running")
      .eq("lease_token", leaseToken)
      .select();
    if (error) throw new Error(`[durable_jobs] renewLease failed: ${error.message}`);
    if (!data || data.length !== 1) return null;
    return mapRow(data[0]);
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
      leaseToken: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.rows.push(job);
    return { job, deduped: false };
  }

  /**
   * Mirrors the Supabase CAS semantics exactly, including the reclaim and
   * dead-letter-sweep branches. Deliberately has NO `await` between reading
   * `this.rows` and mutating a row, matching the pattern already relied on
   * elsewhere in this codebase (InMemoryApprovalStore.beginExecution,
   * InMemoryAgentStore.create) to stay race-safe under Promise.all — an
   * async function with no internal await runs its whole body as one
   * synchronous unit once invoked.
   */
  async claimBatch(workerId: string, limit = 10): Promise<DurableJob[]> {
    const nowIso = new Date().toISOString();
    const due = this.rows
      .filter((r) => (r.status === "queued" && r.nextAttemptAt <= nowIso) || (r.status === "running" && r.lockExpiresAt !== null && r.lockExpiresAt <= nowIso))
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
      .slice(0, limit);

    const claimed: DurableJob[] = [];
    for (const job of due) {
      const isReclaim = job.status === "running";

      if (isReclaim && job.attempts >= job.maxAttempts) {
        // Re-verify the exact CAS precondition — another concurrent claimer
        // may have already swept or reclaimed this row earlier in this same
        // loop (can't happen within one claimBatch call since we iterate
        // sequentially with no await, but a concurrent claimBatch call
        // interleaved via Promise.all could have already mutated it).
        if (job.status === "running" && job.lockExpiresAt !== null && job.lockExpiresAt <= nowIso) {
          job.status = "dead_letter";
          job.lastError = "exceeded max_attempts after repeated crash/reclaim without an explicit fail()";
          job.lockedBy = null;
          job.lockedAt = null;
          job.lockExpiresAt = null;
          job.leaseToken = null;
          job.updatedAt = nowIso;
        }
        continue;
      }

      // Re-verify the CAS precondition immediately before mutating, since a
      // concurrent claimBatch (interleaved via Promise.all against this
      // same store instance) may have already claimed this exact job.
      const stillEligible = isReclaim
        ? job.status === "running" && job.lockExpiresAt !== null && job.lockExpiresAt <= nowIso
        : job.status === "queued" && job.nextAttemptAt <= nowIso;
      if (!stillEligible) continue;

      job.status = "running";
      job.lockedBy = workerId;
      job.lockedAt = nowIso;
      job.lockExpiresAt = new Date(Date.now() + DEFAULT_LEASE_DURATION_SECONDS * 1000).toISOString();
      job.leaseToken = randomUUID();
      job.attempts += 1;
      job.updatedAt = nowIso;
      claimed.push(job);
    }
    return claimed;
  }

  async complete(tenantId: string, id: string, leaseToken: string): Promise<DurableJob | null> {
    const job = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (!job || job.status !== "running" || job.leaseToken !== leaseToken) return null;
    job.status = "succeeded";
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    job.lockedBy = null;
    job.lockedAt = null;
    job.lockExpiresAt = null;
    return job;
  }

  async fail(tenantId: string, id: string, errorMessage: string, leaseToken: string): Promise<DurableJob | null> {
    const job = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (!job || job.status !== "running" || job.leaseToken !== leaseToken) return null;

    const exhausted = job.attempts >= job.maxAttempts;
    job.status = exhausted ? "dead_letter" : "queued";
    job.lastError = errorMessage;
    if (!exhausted) job.nextAttemptAt = new Date(Date.now() + computeBackoffSeconds(job.attempts) * 1000).toISOString();
    job.lockedBy = null;
    job.lockedAt = null;
    job.lockExpiresAt = null;
    job.leaseToken = null;
    job.updatedAt = new Date().toISOString();
    return job;
  }

  async renewLease(tenantId: string, id: string, leaseToken: string, extendBySeconds = DEFAULT_LEASE_DURATION_SECONDS): Promise<DurableJob | null> {
    const job = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    if (!job || job.status !== "running" || job.leaseToken !== leaseToken) return null;
    job.lockExpiresAt = new Date(Date.now() + extendBySeconds * 1000).toISOString();
    job.updatedAt = new Date().toISOString();
    return job;
  }

  async getById(tenantId: string, id: string): Promise<DurableJob | null> {
    return this.rows.find((r) => r.tenantId === tenantId && r.id === id) ?? null;
  }

  async listByTenant(tenantId: string, opts: { status?: DurableJob["status"] } = {}): Promise<DurableJob[]> {
    return this.rows.filter((r) => r.tenantId === tenantId && (!opts.status || r.status === opts.status));
  }

  all(): DurableJob[] {
    return [...this.rows];
  }
}
