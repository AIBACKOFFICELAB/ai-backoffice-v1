import { DurableJob } from "./types";
import { JobHandler } from "./queue";

/**
 * Registered job_type -> handler. Empty in P0 beyond the diagnostic handler
 * below — no existing workflow has been migrated onto the durable queue yet
 * (see docs/adr/0001-durable-execution-layer.md "Migration strategy": the
 * existing Missed Call Recovery / Estimate Follow-up cron paths stay as they
 * are during P0). Add a handler here, keyed by job_type, when a workflow is
 * ready to move onto durable execution.
 */
export const JOB_HANDLERS: Record<string, JobHandler> = {
  "diagnostic.echo": async (job: DurableJob) => {
    console.info("[durable_jobs] diagnostic.echo processed", { jobId: job.id, tenantId: job.tenantId, payload: job.payload });
  },
};
