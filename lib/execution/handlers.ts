import { DurableJob, JobHandlerContext, JobHandlerDefinition } from "./types";
import { registerJobHandler } from "./queue";

/**
 * Registered job_type -> handler. Empty in P0 beyond the diagnostic handler
 * below — no existing workflow has been migrated onto the durable queue yet
 * (see docs/adr/0001-durable-execution-layer.md "Migration strategy": the
 * existing Missed Call Recovery / Estimate Follow-up cron paths stay as they
 * are during P0). Add a handler here, keyed by job_type, when a workflow is
 * ready to move onto durable execution.
 *
 * Every handler here is `consequential: false` — none has a real external
 * or customer-facing/financial effect (see the P0.9 Slice B effect-
 * idempotency contract in lib/execution/types.ts::JobHandlerDefinition). A
 * future handler that DOES have such an effect must set
 * `consequential: true` and declare `deriveEffectKey` — registerJobHandler
 * enforces this at registration time; it is not optional documentation.
 */
const diagnosticEchoHandler: JobHandlerDefinition = registerJobHandler({
  jobType: "diagnostic.echo",
  version: 1,
  consequential: false,
  async run(job: DurableJob, ctx: JobHandlerContext) {
    console.info("[durable_jobs] diagnostic.echo processed", { jobId: job.id, tenantId: ctx.tenantId, payload: job.payload, effectKey: ctx.effectKey });
  },
});

export const JOB_HANDLERS: Record<string, JobHandlerDefinition> = {
  [diagnosticEchoHandler.jobType]: diagnosticEchoHandler,
};
