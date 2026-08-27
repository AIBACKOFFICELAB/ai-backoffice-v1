/**
 * Durable Execution Layer (P0.6, hardened P0.9 Slice B — findings H-02,
 * B.1-B.6). See docs/adr/0001-durable-execution-layer.md and
 * db/migrations/018_p0_durable_execution_audit_hardening.sql.
 */

export type DurableJobStatus = "queued" | "running" | "succeeded" | "failed" | "dead_letter" | "cancelled";

/**
 * Finite lease duration for a claimed job (B.4). Long enough for P0's
 * mock/diagnostic handlers to complete without needing a heartbeat; short
 * enough to bound how long a genuinely crashed worker's job stays stuck
 * before another worker may reclaim it. A handler doing real work longer
 * than this MUST call ctx.heartbeat() periodically (see queue.ts) to renew
 * its lease — the durable-jobs layer intentionally does not try to guess a
 * handler's real runtime.
 */
export const DEFAULT_LEASE_DURATION_SECONDS = 300;

export type DurableJob = {
  id: string;
  tenantId: string;
  jobType: string;
  payload: Record<string, unknown>;
  status: DurableJobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  idempotencyKey: string | null;
  correlationId: string | null;
  /** Diagnostic only (worker hostname/pid, for logs/observability) — never
   * the ownership predicate. A worker id can be reused across a process
   * restart, so leaseToken (below) is the sole thing complete()/fail()/
   * renewLease() check (B.1). */
  lockedBy: string | null;
  lockedAt: string | null;
  lockExpiresAt: string | null;
  /** The actual ownership credential for the CURRENT lease. Freshly
   * generated on every claim (including a reclaim of an expired lease) —
   * distinguishes "worker A's claim #1" from "worker A reclaiming its own
   * old job after restarting with the same id," so a stale executor can
   * never complete/fail/heartbeat a lease that's been superseded, even by
   * a worker sharing its old lockedBy value. null only when the job has
   * never been claimed (status='queued', first attempt). */
  leaseToken: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type EnqueueJobInput = {
  tenantId: string;
  jobType: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  /** Set for any job whose trigger might redeliver — enqueue is then safe
   * to call twice for the same logical unit of work. */
  idempotencyKey?: string | null;
  correlationId?: string | null;
  /** ISO timestamp for the first attempt; defaults to now (immediate). */
  runAt?: string;
};

export type JobOutcome =
  | { jobId: string; status: "succeeded" }
  | { jobId: string; status: "retrying"; attempts: number; nextAttemptAt: string; reason: string }
  | { jobId: string; status: "dead_letter"; attempts: number; reason: string }
  /** This worker's lease was lost mid-flight (superseded by a reclaim, or
   * the job reached a terminal state some other way) before it could
   * record complete()/fail() — B.3's zero-row-update case. Not an error:
   * the job is being handled by whoever now holds the lease (or already
   * has been). Handled, never thrown, so one stale claim in a batch never
   * crashes the rest of processDueJobs' loop. */
  | { jobId: string; status: "stale"; reason: string };

/**
 * Effect-idempotency contract (P0.9 Slice B, finding B-05). A registered
 * job handler.
 *
 * EXPLICIT GUARANTEE — read before registering a consequential handler:
 * the durable-jobs layer guarantees AT-LEAST-ONCE execution with a STABLE,
 * RETRY-INVARIANT effect key (ctx.effectKey) — the same key on every
 * claim/reclaim/retry of the same logical job. It does NOT and CANNOT
 * guarantee exactly-once EXTERNAL effects by itself: a crash between an
 * external call succeeding and this layer recording that success WILL
 * cause a retry to run the handler body again. A handler with a
 * consequential (non-idempotent, customer-facing or financial) external
 * effect MUST use ctx.effectKey as a provider-supported idempotency key
 * (Stripe idempotency-key, email-provider dedupe id, etc.) or its own
 * effect ledger keyed by ctx.effectKey — never assume writing a DB row
 * afterward is sufficient, and never assume calling the same job twice is
 * safe just because the job id is the same.
 *
 * `registerJobHandler` enforces the declaration half of this contract at
 * registration time: a consequential handler without a `deriveEffectKey`
 * is rejected outright (see queue.ts) rather than silently defaulting to
 * "probably fine."
 */
export interface JobHandlerDefinition {
  jobType: string;
  /** Bumped whenever this handler's effect semantics change. */
  version: number;
  /** true if invoking this handler can cause a real external or
   * customer-facing/financial effect that must not be blindly repeated.
   * P0 ships no such handler — every P0 handler is `consequential: false`
   * (see handlers.ts) — this field exists so a FUTURE handler cannot be
   * silently wired up as "durable and retried" without declaring how it
   * stays idempotent across retries. */
  consequential: boolean;
  /** Required when consequential is true (enforced by registerJobHandler).
   * Must return the SAME key for the same logical job across every
   * claim/reclaim/retry — the default (job.id-derived) key already
   * satisfies this, so most handlers can omit it; override only when a
   * different stable identity (e.g. a caller-supplied idempotencyKey) is
   * more appropriate for the downstream provider. */
  deriveEffectKey?: (job: DurableJob) => string;
  run(job: DurableJob, ctx: JobHandlerContext): Promise<void>;
}

export type JobHandlerContext = {
  /** Derived from the CLAIMED job row itself, never from caller-supplied
   * context (B.6) — the authoritative tenant for this execution. */
  tenantId: string;
  /** Stable across every retry of this logical job — see
   * JobHandlerDefinition's doc comment above for the full contract. */
  effectKey: string;
  /** Renews this job's lease. Requires this handler to still hold the
   * active lease it was invoked under (B.4) — returns false, rather than
   * throwing, if the lease has already been lost/superseded, so a
   * long-running handler can check it and abort cleanly instead of
   * continuing to do work nobody will record. */
  heartbeat(): Promise<boolean>;
};
