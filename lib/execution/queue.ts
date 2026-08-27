import { randomUUID } from "crypto";
import { DurableJob, EnqueueJobInput, JobOutcome } from "./types";
import { DurableJobStore, SupabaseDurableJobStore } from "./store";

const defaultStore = new SupabaseDurableJobStore();

export async function enqueueJob(input: EnqueueJobInput, store: DurableJobStore = defaultStore): Promise<{ job: DurableJob; deduped: boolean }> {
  if (!input.tenantId) throw new Error("enqueueJob requires tenantId");
  if (!input.jobType) throw new Error("enqueueJob requires jobType");
  return store.enqueue(input);
}

export type JobHandler = (job: DurableJob) => Promise<void>;

/**
 * Claims and processes one batch of due jobs. Called from the internal cron
 * route (app/api/internal/durable-jobs/process/route.ts); safe to call
 * concurrently — claiming is compare-and-swap (see store.ts), so two
 * overlapping invocations never double-process the same job.
 */
export async function processDueJobs(
  handlers: Record<string, JobHandler>,
  deps: { store?: DurableJobStore; workerId?: string; limit?: number } = {}
): Promise<JobOutcome[]> {
  const store = deps.store ?? defaultStore;
  const workerId = deps.workerId ?? `worker-${randomUUID()}`;
  const claimed = await store.claimBatch(workerId, deps.limit ?? 10);

  const results: JobOutcome[] = [];
  for (const job of claimed) {
    const handler = handlers[job.jobType];
    if (!handler) {
      const updated = await store.fail(job.tenantId, job.id, `no handler registered for job_type '${job.jobType}'`);
      results.push(toOutcome(updated));
      continue;
    }
    try {
      await handler(job);
      await store.complete(job.tenantId, job.id);
      results.push({ jobId: job.id, status: "succeeded" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = await store.fail(job.tenantId, job.id, message);
      results.push(toOutcome(updated));
    }
  }
  return results;
}

function toOutcome(job: DurableJob): JobOutcome {
  if (job.status === "dead_letter") {
    return { jobId: job.id, status: "dead_letter", attempts: job.attempts, reason: job.lastError ?? "unknown" };
  }
  return { jobId: job.id, status: "retrying", attempts: job.attempts, nextAttemptAt: job.nextAttemptAt, reason: job.lastError ?? "unknown" };
}
