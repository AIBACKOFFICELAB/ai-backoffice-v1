import { describe, it, expect } from "vitest";
import { enqueueJob, processDueJobs } from "./queue";
import { InMemoryDurableJobStore, computeBackoffSeconds } from "./store";

describe("durable execution — retry, backoff, dead-letter (P0.6)", () => {
  it("a handler that succeeds completes the job on the first pass", async () => {
    const store = new InMemoryDurableJobStore();
    await enqueueJob({ tenantId: "t1", jobType: "demo" }, store);

    const results = await processDueJobs({ demo: async () => {} }, { store });
    expect(results).toEqual([{ jobId: results[0].jobId, status: "succeeded" }]);
    expect((await store.listByTenant("t1"))[0].status).toBe("succeeded");
  });

  it("a failing handler retries with exponential backoff instead of immediately re-running", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await enqueueJob({ tenantId: "t1", jobType: "demo", maxAttempts: 5 }, store);

    let calls = 0;
    const results = await processDueJobs({ demo: async () => { calls++; throw new Error("transient failure"); } }, { store });

    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({ status: "retrying", attempts: 1 });

    const afterFirstFailure = await store.getById("t1", job.id);
    expect(afterFirstFailure?.status).toBe("queued");
    expect(afterFirstFailure?.attempts).toBe(1);
    // next_attempt_at must be in the future — the whole point of backoff.
    expect(new Date(afterFirstFailure!.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());

    // A poll immediately after must NOT reclaim it — it isn't due yet.
    const secondPass = await processDueJobs({ demo: async () => { calls++; } }, { store });
    expect(secondPass).toHaveLength(0);
    expect(calls).toBe(1);
  });

  it("exhausting max_attempts moves the job to dead_letter, not an infinite retry", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await enqueueJob({ tenantId: "t1", jobType: "demo", maxAttempts: 2, runAt: new Date(0).toISOString() }, store);

    // Simulate two polls, forcing next_attempt_at back to "now" between them
    // so the retry backoff itself doesn't block the test.
    await processDueJobs({ demo: async () => { throw new Error("fail 1"); } }, { store });
    const midway = await store.getById("t1", job.id);
    expect(midway?.status).toBe("queued");
    midway!.nextAttemptAt = new Date(0).toISOString(); // fast-forward past backoff for the test

    const finalResults = await processDueJobs({ demo: async () => { throw new Error("fail 2"); } }, { store });
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
    expect((await store.listByTenant("t1"))).toHaveLength(1);
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
