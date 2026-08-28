import { randomUUID } from "crypto";
import { DurableJob, EnqueueJobInput, JobOutcome, JobHandlerDefinition, JobHandlerContext, DEFAULT_LEASE_DURATION_SECONDS, computeEffectKey } from "./types";
import { DurableJobStore, SupabaseDurableJobStore } from "./store";

const defaultStore = new SupabaseDurableJobStore();

export async function enqueueJob(input: EnqueueJobInput, store: DurableJobStore = defaultStore): Promise<{ job: DurableJob; deduped: boolean }> {
  if (!input.tenantId) throw new Error("enqueueJob requires tenantId");
  if (!input.jobType) throw new Error("enqueueJob requires jobType");
  return store.enqueue(input);
}

/**
 * Registers a job handler. Light structural validation only (P0.9 Slice B
 * correction 2): the effect-key stability guarantee no longer depends on
 * anything a handler declares — see computeEffectKey() in types.ts, which
 * the runtime computes unconditionally for every handler. This function
 * still exists as the single registration entry point (so a future,
 * stronger check has one place to live) and to catch an obviously
 * malformed definition early rather than at first invocation.
 */
export function registerJobHandler(def: JobHandlerDefinition): JobHandlerDefinition {
  if (!def.jobType) {
    throw new Error("[durable_jobs] a job handler must declare a non-empty jobType");
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new Error(`[durable_jobs] handler '${def.jobType}' must declare an integer version >= 1`);
  }
  return def;
}

/**
 * Claims and processes one batch of due jobs. Called from the internal cron
 * route (app/api/internal/durable-jobs/process/route.ts); safe to call
 * concurrently — claiming is compare-and-swap (see store.ts), so two
 * overlapping invocations never double-process the same job.
 *
 * Every complete()/fail() call below is keyed on the lease token the claim
 * for THIS job issued (job.leaseToken) — never on worker identity alone
 * (B.1/B.3). A `null` return from complete()/fail() means this worker's
 * lease was lost before it could record the outcome (superseded by a
 * reclaim, most likely because this worker took longer than the lease
 * duration without heartbeating) — that is reported as a `"stale"`
 * JobOutcome, not thrown, so one stale claim in a batch never aborts
 * processing of the rest.
 */
export async function processDueJobs(
  handlers: Record<string, JobHandlerDefinition>,
  deps: { store?: DurableJobStore; workerId?: string; limit?: number; leaseDurationSeconds?: number } = {}
): Promise<JobOutcome[]> {
  const store = deps.store ?? defaultStore;
  const workerId = deps.workerId ?? `worker-${randomUUID()}`;
  const leaseDurationSeconds = deps.leaseDurationSeconds ?? DEFAULT_LEASE_DURATION_SECONDS;
  const claimed = await store.claimBatch(workerId, deps.limit ?? 10);

  const results: JobOutcome[] = [];
  for (const job of claimed) {
    // claimBatch always sets a lease token on every job it successfully
    // claims — this null check is defensive only, never expected to trip.
    const leaseToken = job.leaseToken;
    if (!leaseToken) {
      results.push({ jobId: job.id, status: "stale", reason: "claimed job has no lease token" });
      continue;
    }

    const handler = handlers[job.jobType];
    if (!handler) {
      const updated = await store.fail(job.tenantId, job.id, `no handler registered for job_type '${job.jobType}'`, leaseToken);
      results.push(updated ? toOutcome(updated) : staleOutcome(job.id, "no-handler failure"));
      continue;
    }

    // B.6: tenant identity for this execution comes exclusively from the
    // CLAIMED job row (job.tenantId) — a global worker may discover jobs
    // across tenants, but the handler's context can never be pointed at a
    // caller-supplied tenant; it is always the claimed row's own tenant.
    //
    // P0.9 Slice B correction 2: effectKey is ALWAYS computeEffectKey(job)
    // — runtime-owned, derived only from immutable job identity. No
    // handler-supplied function is consulted; a handler has no way to
    // change this value from one attempt to another.
    const ctx: JobHandlerContext = {
      tenantId: job.tenantId,
      effectKey: computeEffectKey(job),
      heartbeat: async () => (await store.renewLease(job.tenantId, job.id, leaseToken, leaseDurationSeconds)) !== null,
    };

    try {
      await handler.run(job, ctx);
      const completed = await store.complete(job.tenantId, job.id, leaseToken);
      results.push(completed ? { jobId: job.id, status: "succeeded" } : staleOutcome(job.id, "success"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = await store.fail(job.tenantId, job.id, message, leaseToken);
      results.push(updated ? toOutcome(updated) : staleOutcome(job.id, "failure"));
    }
  }
  return results;
}

function staleOutcome(jobId: string, whatWasLost: string): JobOutcome {
  return { jobId, status: "stale", reason: `lease lost before ${whatWasLost} could be recorded` };
}

function toOutcome(job: DurableJob): JobOutcome {
  if (job.status === "dead_letter") {
    return { jobId: job.id, status: "dead_letter", attempts: job.attempts, reason: job.lastError ?? "unknown" };
  }
  return { jobId: job.id, status: "retrying", attempts: job.attempts, nextAttemptAt: job.nextAttemptAt, reason: job.lastError ?? "unknown" };
}
