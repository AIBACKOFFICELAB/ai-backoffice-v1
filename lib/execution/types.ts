/** Durable Execution Layer (P0.6). See docs/adr/0001-durable-execution-layer.md. */

export type DurableJobStatus = "queued" | "running" | "succeeded" | "failed" | "dead_letter" | "cancelled";

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
  lockedBy: string | null;
  lockedAt: string | null;
  lockExpiresAt: string | null;
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
  | { jobId: string; status: "dead_letter"; attempts: number; reason: string };
