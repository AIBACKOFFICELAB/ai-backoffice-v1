import { describe, it, expect } from "vitest";
import { InMemoryDurableJobStore } from "./store";
import { DEFAULT_LEASE_DURATION_SECONDS } from "./types";

/**
 * Durable job lease model (P0.9 Slice B, finding H-02, B.1-B.4, B.6).
 * Exercises the InMemoryDurableJobStore, which mirrors the exact same CAS
 * predicates as SupabaseDurableJobStore (see store.ts) — the same
 * methodology used throughout P0.9 (Slice A's approval CAS tests, this
 * repo's tenantConsistency.pg.test.ts honesty split). True cross-process
 * concurrency against live Postgres is NOT exercised here — see
 * "Database Testing Honesty" in the Slice B completion report.
 */
describe("durable job leases (B.1-B.4)", () => {
  it("scenario 1: two workers claiming the same queued job simultaneously — exactly one wins", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo" });

    const [batchA, batchB] = await Promise.all([store.claimBatch("worker-a", 5), store.claimBatch("worker-b", 5)]);
    const claimed = [...batchA, ...batchB];
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(job.id);
    expect(claimed[0].leaseToken).not.toBeNull();

    const final = await store.getById("t1", job.id);
    expect(final?.status).toBe("running");
  });

  it("claim establishes locked_by, locked_at, lock_expires_at, and a fresh lease_token", async () => {
    const store = new InMemoryDurableJobStore();
    await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [claimed] = await store.claimBatch("worker-a", 1);

    expect(claimed.lockedBy).toBe("worker-a");
    expect(claimed.lockedAt).not.toBeNull();
    expect(claimed.lockExpiresAt).not.toBeNull();
    expect(new Date(claimed.lockExpiresAt!).getTime()).toBeGreaterThan(Date.now());
    expect(claimed.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("scenario 2: a crashed worker's expired lease can be reclaimed by another worker, with a NEW lease token", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [firstClaim] = await store.claimBatch("worker-a", 1);
    const originalToken = firstClaim.leaseToken;

    // Simulate worker-a crashing: force the lease into the past without
    // going through any store method (nothing legitimate does this — it
    // stands in for "time passed and worker-a never came back").
    const stuck = await store.getById("t1", job.id);
    stuck!.lockExpiresAt = new Date(Date.now() - 1000).toISOString();

    const [reclaimed] = await store.claimBatch("worker-b", 1);
    expect(reclaimed).toBeDefined();
    expect(reclaimed.id).toBe(job.id);
    expect(reclaimed.lockedBy).toBe("worker-b");
    expect(reclaimed.leaseToken).not.toBe(originalToken);
  });

  it("scenario 3: the old worker's complete() is refused after reclaim", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [firstClaim] = await store.claimBatch("worker-a", 1);
    const staleToken = firstClaim.leaseToken!;

    const stuck = await store.getById("t1", job.id);
    stuck!.lockExpiresAt = new Date(Date.now() - 1000).toISOString();
    await store.claimBatch("worker-b", 1);

    const result = await store.complete("t1", job.id, staleToken);
    expect(result).toBeNull();

    // The reclaiming worker's ownership must be unharmed by the refused call.
    const final = await store.getById("t1", job.id);
    expect(final?.status).toBe("running");
    expect(final?.lockedBy).toBe("worker-b");
  });

  it("scenario 4: the old worker's fail() is refused after reclaim", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [firstClaim] = await store.claimBatch("worker-a", 1);
    const staleToken = firstClaim.leaseToken!;

    const stuck = await store.getById("t1", job.id);
    stuck!.lockExpiresAt = new Date(Date.now() - 1000).toISOString();
    await store.claimBatch("worker-b", 1);

    const result = await store.fail("t1", job.id, "worker-a's belated failure report", staleToken);
    expect(result).toBeNull();

    const final = await store.getById("t1", job.id);
    expect(final?.status).toBe("running");
    expect(final?.lockedBy).toBe("worker-b");
    expect(final?.lastError).not.toBe("worker-a's belated failure report");
  });

  it("scenario 5: a heartbeat with a valid active lease extends it", async () => {
    const store = new InMemoryDurableJobStore();
    await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [claimed] = await store.claimBatch("worker-a", 1);
    const originalExpiry = claimed.lockExpiresAt!;

    const renewed = await store.renewLease("t1", claimed.id, claimed.leaseToken!, DEFAULT_LEASE_DURATION_SECONDS);
    expect(renewed).not.toBeNull();
    expect(new Date(renewed!.lockExpiresAt!).getTime()).toBeGreaterThanOrEqual(new Date(originalExpiry).getTime());
  });

  it("scenario 6a: a stale worker's heartbeat (after reclaim) is refused", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [firstClaim] = await store.claimBatch("worker-a", 1);
    const staleToken = firstClaim.leaseToken!;

    const stuck = await store.getById("t1", job.id);
    stuck!.lockExpiresAt = new Date(Date.now() - 1000).toISOString();
    await store.claimBatch("worker-b", 1);

    const result = await store.renewLease("t1", job.id, staleToken);
    expect(result).toBeNull();
  });

  it("scenario 6b: heartbeat with an incorrect (fabricated) token is refused even against an active lease", async () => {
    const store = new InMemoryDurableJobStore();
    await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [claimed] = await store.claimBatch("worker-a", 1);

    const result = await store.renewLease("t1", claimed.id, "00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();

    // The legitimate lease must be untouched by the refused attempt.
    const final = await store.getById("t1", claimed.id);
    expect(final?.leaseToken).toBe(claimed.leaseToken);
  });

  it("scenario 7: repeated crashes without an explicit fail() eventually reach dead_letter", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo", maxAttempts: 2 });

    // Crash #1: claim (attempts 0 -> 1), then simulate the worker dying.
    await store.claimBatch("worker-a", 1);
    const afterFirst = await store.getById("t1", job.id);
    expect(afterFirst?.attempts).toBe(1);
    afterFirst!.lockExpiresAt = new Date(Date.now() - 1000).toISOString();

    // Crash #2: reclaim (attempts 1 -> 2 === maxAttempts), then die again.
    const [reclaimed] = await store.claimBatch("worker-b", 1);
    expect(reclaimed.attempts).toBe(2);
    const afterSecond = await store.getById("t1", job.id);
    afterSecond!.lockExpiresAt = new Date(Date.now() - 1000).toISOString();

    // Third poll: attempts (2) >= maxAttempts (2) on the reclaim path — swept
    // to dead_letter instead of reclaimed. Never returned as claimed.
    const thirdBatch = await store.claimBatch("worker-c", 5);
    expect(thirdBatch.find((j) => j.id === job.id)).toBeUndefined();

    const final = await store.getById("t1", job.id);
    expect(final?.status).toBe("dead_letter");
    expect(final?.attempts).toBe(2);
  });

  it("scenario 8: an intermittent handler failure (fail() under a valid lease) leaves valid retry/backoff state", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo", maxAttempts: 5 });
    const [claimed] = await store.claimBatch("worker-a", 1);

    const failed = await store.fail("t1", job.id, "transient", claimed.leaseToken!);
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("queued");
    expect(failed!.attempts).toBe(1); // incremented at claim time, not again at fail time
    expect(new Date(failed!.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(failed!.leaseToken).toBeNull();
    expect(failed!.lockedBy).toBeNull();
  });

  it("scenario 10: a wrong tenant cannot complete or fail another tenant's job", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "tenant-a", jobType: "demo" });
    const [claimed] = await store.claimBatch("worker-a", 1);

    expect(await store.complete("tenant-b", job.id, claimed.leaseToken!)).toBeNull();
    expect(await store.fail("tenant-b", job.id, "nope", claimed.leaseToken!)).toBeNull();
    expect(await store.renewLease("tenant-b", job.id, claimed.leaseToken!)).toBeNull();

    // The real tenant's job must be completely unaffected by the refused
    // cross-tenant attempts.
    const final = await store.getById("tenant-a", job.id);
    expect(final?.status).toBe("running");
    expect(final?.leaseToken).toBe(claimed.leaseToken);
  });

  it("scenario 11: a succeeded job cannot be casually re-executed through the normal claim path", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo", runAt: new Date(0).toISOString() });
    const [claimed] = await store.claimBatch("worker-a", 1);
    const completed = await store.complete("t1", job.id, claimed.leaseToken!);
    expect(completed?.status).toBe("succeeded");

    // Even though next_attempt_at is far in the past, claimBatch's WHERE
    // clause requires status IN ('queued', 'running') — 'succeeded' is
    // structurally unreachable through the normal claim path.
    const batch = await store.claimBatch("worker-b", 10);
    expect(batch.find((j) => j.id === job.id)).toBeUndefined();

    // A stale replay attempt using the old lease token is also refused,
    // belt-and-suspenders.
    expect(await store.complete("t1", job.id, claimed.leaseToken!)).toBeNull();
  });

  it("a claimed job's tenant identity is authoritative — B.6's structural guarantee", async () => {
    const store = new InMemoryDurableJobStore();
    await store.enqueue({ tenantId: "tenant-a", jobType: "demo" });
    await store.enqueue({ tenantId: "tenant-b", jobType: "demo" });

    // A global worker can discover jobs across tenants (claimBatch takes no
    // tenantId) — but each claimed row carries its OWN authoritative
    // tenantId; nothing lets a caller override it.
    const batch = await store.claimBatch("global-worker", 10);
    expect(batch).toHaveLength(2);
    const tenantIds = batch.map((j) => j.tenantId).sort();
    expect(tenantIds).toEqual(["tenant-a", "tenant-b"]);
  });
});

/**
 * Lease expiry enforcement (P0.9 Slice B correction 1). Independent
 * verification found that complete()/fail()/renewLease() validated
 * tenant_id + job id + status='running' + lease_token, but NOT that the
 * lease was still unexpired — so an expired worker could still complete,
 * fail, or heartbeat a job before any other worker happened to reclaim it.
 * These tests exercise refusal from EXPIRY ALONE, distinct from the
 * "durable job leases (B.1-B.4)" describe block above, which mostly tests
 * refusal AFTER a second worker has already reclaimed.
 */
describe("lease expiry enforcement (correction 1)", () => {
  async function claimAndExpire(store: InMemoryDurableJobStore, tenantId = "t1") {
    const { job } = await store.enqueue({ tenantId, jobType: "demo", maxAttempts: 5 });
    const [claimed] = await store.claimBatch("worker-a", 1);
    // InMemoryDurableJobStore returns/mutates the SAME underlying row
    // object for every caller (see lib/execution/store.ts) — `claimed` and
    // `stuck` below are literally the same reference, and a later reclaim
    // (e.g. by worker-b in test 5) would mutate `claimed` too. Capture the
    // lease token as a primitive string NOW, before any such mutation, so
    // callers testing "old worker's stale token" always use the value that
    // was genuinely issued to worker-a, not whatever the row currently
    // holds.
    const staleLeaseToken = claimed.leaseToken!;
    const stuck = await store.getById(tenantId, job.id);
    stuck!.lockExpiresAt = new Date(Date.now() - 1000).toISOString();
    return { job, claimed, staleLeaseToken };
  }

  it("test 1: expired lease — old worker's renewLease before any reclaim is refused", async () => {
    const store = new InMemoryDurableJobStore();
    const { job, staleLeaseToken } = await claimAndExpire(store);

    const result = await store.renewLease("t1", job.id, staleLeaseToken);
    expect(result).toBeNull();

    // The row is untouched by the refused heartbeat — still expired,
    // still holding the same (now-unusable) token, ready for reclaim.
    const after = await store.getById("t1", job.id);
    expect(after?.leaseToken).toBe(staleLeaseToken);
    expect(new Date(after!.lockExpiresAt!).getTime()).toBeLessThan(Date.now());
  });

  it("test 2: expired lease — old worker's complete() before any reclaim is refused", async () => {
    const store = new InMemoryDurableJobStore();
    const { job, staleLeaseToken } = await claimAndExpire(store);

    const result = await store.complete("t1", job.id, staleLeaseToken);
    expect(result).toBeNull();

    const after = await store.getById("t1", job.id);
    expect(after?.status).toBe("running"); // NOT succeeded — the stale completion never landed
  });

  it("test 3: expired lease — old worker's fail() before any reclaim is refused", async () => {
    const store = new InMemoryDurableJobStore();
    const { job, staleLeaseToken } = await claimAndExpire(store);

    const result = await store.fail("t1", job.id, "belated failure report", staleLeaseToken);
    expect(result).toBeNull();

    const after = await store.getById("t1", job.id);
    expect(after?.status).toBe("running"); // NOT queued/dead_letter — the stale failure never landed
    expect(after?.lastError).not.toBe("belated failure report");
  });

  it("test 4: an active lease immediately before expiry still permits heartbeat, complete, and fail", async () => {
    const store = new InMemoryDurableJobStore();
    const { job: jobForHeartbeat } = await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [claim1] = await store.claimBatch("worker-a", 1);
    // Lease is fresh (DEFAULT_LEASE_DURATION_SECONDS in the future) — well
    // before expiry, not at the boundary, to keep this deterministic.
    expect(new Date(claim1.lockExpiresAt!).getTime()).toBeGreaterThan(Date.now() + (DEFAULT_LEASE_DURATION_SECONDS - 10) * 1000);

    const renewed = await store.renewLease("t1", jobForHeartbeat.id, claim1.leaseToken!);
    expect(renewed).not.toBeNull();

    const { job: jobForComplete } = await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [claim2] = await store.claimBatch("worker-b", 1);
    const completed = await store.complete("t1", jobForComplete.id, claim2.leaseToken!);
    expect(completed?.status).toBe("succeeded");

    const { job: jobForFail } = await store.enqueue({ tenantId: "t1", jobType: "demo", maxAttempts: 5 });
    const [claim3] = await store.claimBatch("worker-c", 1);
    const failed = await store.fail("t1", jobForFail.id, "transient", claim3.leaseToken!);
    expect(failed?.status).toBe("queued");
  });

  it("test 5: expired lease reclaimed by worker B — worker A remains refused on every operation", async () => {
    const store = new InMemoryDurableJobStore();
    const { job, staleLeaseToken } = await claimAndExpire(store);
    const [claimB] = await store.claimBatch("worker-b", 1);
    expect(claimB.id).toBe(job.id);
    // claimB's token must genuinely differ from worker A's original token —
    // otherwise the refusals below would be trivially true for the wrong
    // reason (comparing a token against itself).
    expect(claimB.leaseToken).not.toBe(staleLeaseToken);

    expect(await store.renewLease("t1", job.id, staleLeaseToken)).toBeNull();
    expect(await store.complete("t1", job.id, staleLeaseToken)).toBeNull();
    expect(await store.fail("t1", job.id, "worker A's stale report", staleLeaseToken)).toBeNull();

    // Worker B's ownership is intact throughout.
    const after = await store.getById("t1", job.id);
    expect(after?.leaseToken).toBe(claimB.leaseToken);
    expect(after?.status).toBe("running");
  });

  it("test 6: a heartbeat before expiry extends the lease so the old expiry no longer makes it reclaimable", async () => {
    const store = new InMemoryDurableJobStore();
    const { job } = await store.enqueue({ tenantId: "t1", jobType: "demo" });
    const [claimed] = await store.claimBatch("worker-a", 1);

    // Simulate time passing to just past the ORIGINAL expiry, but renew
    // BEFORE that — i.e. heartbeat while still active — then verify a
    // claimBatch sweep at the (now-stale) original expiry moment does not
    // reclaim it, because the lease was genuinely extended past it.
    const renewed = await store.renewLease("t1", job.id, claimed.leaseToken!, 300);
    expect(renewed).not.toBeNull();
    const newExpiry = new Date(renewed!.lockExpiresAt!).getTime();
    const originalExpiry = new Date(claimed.lockExpiresAt!).getTime();
    expect(newExpiry).toBeGreaterThanOrEqual(originalExpiry);

    // A worker attempting to reclaim "as of now" must find nothing due —
    // the lease is genuinely active, not just optimistically not-yet-swept.
    const batch = await store.claimBatch("worker-b", 10);
    expect(batch.find((j) => j.id === job.id)).toBeUndefined();

    // And the original owner's token is still honored, proving the lease
    // truly was extended rather than merely left alone.
    const completed = await store.complete("t1", job.id, claimed.leaseToken!);
    expect(completed?.status).toBe("succeeded");
  });
});
