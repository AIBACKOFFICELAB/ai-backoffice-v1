import { describe, it, expect } from "vitest";
import { enqueueJob, processDueJobs, registerJobHandler } from "./queue";
import { InMemoryDurableJobStore, computeBackoffSeconds } from "./store";
import { DurableJob, JobHandlerContext, JobHandlerDefinition, computeEffectKey } from "./types";

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
 * Effect-idempotency contract (P0.6 finding B-05, hardened P0.9 Slice B
 * correction 2). See the guarantee documented on JobHandlerDefinition and
 * computeEffectKey in lib/execution/types.ts: at-least-once execution with
 * a stable, retry-invariant effect key that is EXCLUSIVELY runtime-owned —
 * never a claim of exactly-once external effects, and never something a
 * handler can influence.
 */
describe("effect-idempotency contract (B-05, corrected)", () => {
  it("registerJobHandler requires a non-empty jobType", () => {
    expect(() => registerJobHandler({ jobType: "", version: 1, consequential: false, async run() {} })).toThrow(/jobType/);
  });

  it("registerJobHandler requires a valid integer version", () => {
    expect(() => registerJobHandler({ jobType: "x", version: 0, consequential: false, async run() {} })).toThrow(/version/);
  });

  it("registerJobHandler accepts a well-formed consequential handler", () => {
    const def = registerJobHandler({ jobType: "send_invoice", version: 1, consequential: true, async run() {} });
    expect(def.jobType).toBe("send_invoice");
  });

  it("test 1: attempts changing across claim/reclaim does not change the effect key", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo", maxAttempts: 5 });

    const [claim1] = await store.claimBatch("worker-a", 1);
    expect(claim1.attempts).toBe(1);
    const keyAfterClaim1 = computeEffectKey(claim1);

    // Simulate a crash + reclaim: attempts advances to 2.
    const stuck = await store.getById("t1", job.id);
    stuck!.lockExpiresAt = new Date(Date.now() - 1000).toISOString();
    const [claim2] = await store.claimBatch("worker-b", 1);
    expect(claim2.attempts).toBe(2);
    const keyAfterClaim2 = computeEffectKey(claim2);

    expect(keyAfterClaim2).toBe(keyAfterClaim1);
  });

  it("test 2: a changed lease_token does not change the effect key", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [claim1] = await store.claimBatch("worker-a", 1);
    // InMemoryDurableJobStore returns/mutates the SAME underlying row object
    // for every caller (see lib/execution/store.ts) — claim1 and the row
    // store.getById returns below are literally the same reference, so a
    // later reclaim mutates claim1 too. Capture the primitives we're
    // asserting on NOW, before the reclaim below, rather than reading them
    // off claim1 afterward.
    const firstToken = claim1.leaseToken;
    const firstEffectKey = computeEffectKey(claim1);
    const stuck = await store.getById("t1", job.id);
    stuck!.lockExpiresAt = new Date(Date.now() - 1000).toISOString();
    const [claim2] = await store.claimBatch("worker-b", 1);

    expect(claim2.leaseToken).not.toBe(firstToken);
    expect(computeEffectKey(claim2)).toBe(firstEffectKey);
  });

  it("test 3: a changed worker (locked_by) does not change the effect key", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [claim1] = await store.claimBatch("worker-alpha", 1);
    // Same aliasing note as test 2 above — capture before the reclaim.
    const firstLockedBy = claim1.lockedBy;
    const firstEffectKey = computeEffectKey(claim1);
    const stuck = await store.getById("t1", job.id);
    stuck!.lockExpiresAt = new Date(Date.now() - 1000).toISOString();
    const [claim2] = await store.claimBatch("worker-beta", 1);

    expect(claim2.lockedBy).toBe("worker-beta");
    expect(firstLockedBy).toBe("worker-alpha");
    expect(computeEffectKey(claim2)).toBe(firstEffectKey);
  });

  it("test 4: retry/reclaim of the same job yields the same ctx.effectKey through processDueJobs end-to-end", async () => {
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

  it("test 5: distinct jobs get distinct default effect keys", async () => {
    const store = new InMemoryDurableJobStore();
    const { job: jobA } = await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const { job: jobB } = await store.enqueue({ tenantId: "t1", jobType: "demo" });

    expect(jobA.id).not.toBe(jobB.id);
    expect(computeEffectKey(jobA)).not.toBe(computeEffectKey(jobB));
  });

  it("test 6: the same enqueue idempotency identity yields the same logical job and the same effect key", async () => {
    const store = new InMemoryDurableJobStore();
    const first = await store.enqueue({ tenantId: "t1", jobType: "demo", idempotencyKey: "order-42" });
    const second = await store.enqueue({ tenantId: "t1", jobType: "demo", idempotencyKey: "order-42" });

    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(computeEffectKey(second.job)).toBe(computeEffectKey(first.job));
    // Namespaced distinctly from the job.id-derived default, so an
    // idempotencyKey-based key can never collide with a bare id-derived one.
    expect(computeEffectKey(first.job)).toBe("idempotency:order-42");
  });

  it("test 7: a consequential handler cannot override the runtime-owned effect key", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await enqueueJob({ tenantId: "t1", jobType: "demo" }, store);

    let observedKey: string | null = null;
    const consequentialHandler = handler(
      async (_job, ctx) => {
        observedKey = ctx.effectKey;
      },
      { consequential: true }
    );
    // JobHandlerDefinition has no field through which a handler can supply
    // its own key — this simulates an attempt to smuggle one in anyway
    // (e.g. a handler author copying an old shape); the runtime must never
    // read it.
    (consequentialHandler as unknown as Record<string, unknown>).deriveEffectKey = () => "hacked-key";

    await processDueJobs({ demo: consequentialHandler }, { store });

    expect(observedKey).toBe(`demo:${job.id}`);
    expect(observedKey).not.toBe("hacked-key");
  });
});
