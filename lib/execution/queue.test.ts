import { describe, it, expect } from "vitest";
import { enqueueJob, processDueJobs, registerJobHandler } from "./queue";
import { InMemoryDurableJobStore, computeBackoffSeconds } from "./store";
import { DurableJob, JobHandlerContext, JobHandlerDefinition } from "./types";

/** Minimal non-consequential handler builder — keeps each test's `run` body
 * terse while still going through the real JobHandlerDefinition shape. */
function handler(run: (job: DurableJob, ctx: JobHandlerContext) => Promise<void>, overrides: Partial<JobHandlerDefinition> = {}): JobHandlerDefinition {
  return { jobType: "demo", version: 1, consequential: false, run, ...overrides };
}

describe("durable execution — retry, backoff, dead-letter (P0.6, hardened P0.9 Slice B)", () => {
  it("a handler that succeeds completes the job on the first pass", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueueJob({ tenantId: "t1", jobType: "demo" }, store);

    const results = await processDueJobs({ demo: handler(async () => {}) }, { store });
    expect(results).toEqual([{ jobId: results[0].jobId, status: "succeeded" }]);
    expect((await store.listByTenant("t1"))[0].status).toBe("succeeded");
  });

  it("a failing handler retries with exponential backoff instead of immediately re-running", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await enqueueJob({ tenantId: "t1", jobType: "demo", maxAttempts: 5 }, store);

    let calls = 0;
    const results = await processDueJobs(
      {
        demo: handler(async () => {
          calls++;
          throw new Error("transient failure");
        }),
      },
      { store }
    );

    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({ status: "retrying", attempts: 1 });

    const afterFirstFailure = await store.getById("t1", job.id);
    expect(afterFirstFailure?.status).toBe("queued");
    expect(afterFirstFailure?.attempts).toBe(1);
    // next_attempt_at must be in the future — the whole point of backoff.
    expect(new Date(afterFirstFailure!.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());

    // A poll immediately after must NOT reclaim it — it isn't due yet.
    const secondPass = await processDueJobs(
      {
        demo: handler(async () => {
          calls++;
        }),
      },
      { store }
    );
    expect(secondPass).toHaveLength(0);
    expect(calls).toBe(1);
  });

  it("exhausting max_attempts moves the job to dead_letter, not an infinite retry", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await enqueueJob({ tenantId: "t1", jobType: "demo", maxAttempts: 2, runAt: new Date(0).toISOString() }, store);

    // Simulate two polls, forcing next_attempt_at back to "now" between them
    // so the retry backoff itself doesn't block the test.
    await processDueJobs(
      {
        demo: handler(async () => {
          throw new Error("fail 1");
        }),
      },
      { store }
    );
    const midway = await store.getById("t1", job.id);
    expect(midway?.status).toBe("queued");
    midway!.nextAttemptAt = new Date(0).toISOString(); // fast-forward past backoff for the test

    const finalResults = await processDueJobs(
      {
        demo: handler(async () => {
          throw new Error("fail 2");
        }),
      },
      { store }
    );
    expect(finalResults[0].status).toBe("dead_letter");

    const final = await store.getById("t1", job.id);
    expect(final?.status).toBe("dead_letter");
    expect(final?.attempts).toBe(2);
  });

  it("enqueue is idempotent per (tenantId, idempotencyKey)", async () => {
    const store = new InMemoryDurableJobStore();
    const first = await enqueueJob({ tenantId: "t1", jobType: "demo", idempotencyKey: "webhook-abc" }, store);
    const second = await enqueueJob({ tenantId: "t1", jobType: "demo", idempotencyKey: "webhook-abc" }, store);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(await store.listByTenant("t1")).toHaveLength(1);
  });

  it("a job with no registered handler fails closed rather than hanging", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueueJob({ tenantId: "t1", jobType: "unregistered.type" }, store);
    const results = await processDueJobs({}, { store });
    expect(results[0].status).toBe("retrying");
    expect((results[0] as { reason: string }).reason).toMatch(/no handler registered/);
  });

  it("concurrent claim attempts never double-process the same job (compare-and-swap)", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueueJob({ tenantId: "t1", jobType: "demo" }, store);

    const [batchA, batchB] = await Promise.all([store.claimBatch("worker-a"), store.claimBatch("worker-b")]);
    const totalClaimed = batchA.length + batchB.length;
    expect(totalClaimed).toBe(1);
  });
});

describe("computeBackoffSeconds", () => {
  it("grows exponentially and caps at 1 hour", () => {
    expect(computeBackoffSeconds(1)).toBe(60);
    expect(computeBackoffSeconds(2)).toBe(120);
    expect(computeBackoffSeconds(3)).toBe(240);
    expect(computeBackoffSeconds(10)).toBe(3600);
  });
});

/**
 * Effect-idempotency contract (P0.9 Slice B, finding B-05). See the
 * guarantee documented on JobHandlerDefinition in lib/execution/types.ts:
 * at-least-once execution with a stable, retry-invariant effect key — never
 * a claim of exactly-once external effects.
 */
describe("effect-idempotency contract (B-05)", () => {
  it("registerJobHandler rejects a consequential handler with no deriveEffectKey", () => {
    expect(() =>
      registerJobHandler({
        jobType: "send_invoice",
        version: 1,
        consequential: true,
        async run() {},
      })
    ).toThrow(/deriveEffectKey/);
  });

  it("registerJobHandler accepts a consequential handler that declares deriveEffectKey", () => {
    const def = registerJobHandler({
      jobType: "send_invoice",
      version: 1,
      consequential: true,
      deriveEffectKey: (job) => `invoice:${job.id}`,
      async run() {},
    });
    expect(def.jobType).toBe("send_invoice");
  });

  it("registerJobHandler accepts a non-consequential handler with no deriveEffectKey", () => {
    expect(() => registerJobHandler(handler(async () => {}))).not.toThrow();
  });

  it("scenario 9: the default effect key is stable across every claim/reclaim of the same logical job", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await enqueueJob({ tenantId: "t1", jobType: "demo", maxAttempts: 5 }, store);

    const seenKeys: string[] = [];
    await processDueJobs(
      {
        demo: handler(async (_job, ctx) => {
          seenKeys.push(ctx.effectKey);
          throw new Error("fail once to force a retry");
        }),
      },
      { store }
    );

    // Force the retry to be immediately due, then process it again — same
    // durable job id, second attempt.
    const midway = await store.getById("t1", job.id);
    midway!.nextAttemptAt = new Date(0).toISOString();

    await processDueJobs(
      {
        demo: handler(async (_job, ctx) => {
          seenKeys.push(ctx.effectKey);
        }),
      },
      { store }
    );

    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[0]).toBe(seenKeys[1]);
    expect(seenKeys[0]).toBe(`demo:${job.id}`);
  });

  it("a custom deriveEffectKey overrides the default and is still stable across retries", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueueJob({ tenantId: "t1", jobType: "demo", idempotencyKey: "order-42", maxAttempts: 5 }, store);

    const seenKeys: string[] = [];
    const def = handler(
      async (_job, ctx) => {
        seenKeys.push(ctx.effectKey);
        throw new Error("fail to force a retry");
      },
      { consequential: true, deriveEffectKey: (job) => `order-effect:${job.idempotencyKey}` }
    );
    await processDueJobs({ demo: def }, { store });

    const jobs = await store.listByTenant("t1");
    jobs[0].nextAttemptAt = new Date(0).toISOString();

    await processDueJobs({ demo: { ...def, run: async (_job, ctx) => { seenKeys.push(ctx.effectKey); } } }, { store });

    expect(seenKeys).toEqual(["order-effect:order-42", "order-effect:order-42"]);
  });
});
