import { describe, it, expect } from "vitest";
import { requestApproval, approveApproval, rejectApproval, listPendingApprovals, approveApprovalAsAuthenticatedActor, rejectApprovalAsAuthenticatedActor, resolveApprovalActor, TenantContextResolver } from "./service";
import { InMemoryApprovalStore } from "./store";

describe("approval enforcement (P0.4)", () => {
  it("requestApproval creates a pending approval", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "t1", requestedAction: "draft_customer_message.execute", payloadDigest: "digest-1" }, store);
    expect(approval.status).toBe("pending");
    expect(await listPendingApprovals("t1", store)).toHaveLength(1);
  });

  it("only a tenant owner may approve — staff is refused", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "t1", requestedAction: "x", payloadDigest: "digest-1" }, store);
    await expect(approveApproval("t1", approval.id, "user-1", "staff", store)).rejects.toThrow(/owner/);
    const stillPending = await store.getById("t1", approval.id);
    expect(stillPending?.status).toBe("pending");
  });

  it("an owner can approve a pending approval, recording who and when", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "t1", requestedAction: "x", payloadDigest: "digest-1" }, store);
    const decided = await approveApproval("t1", approval.id, "owner-user", "owner", store);
    expect(decided.status).toBe("approved");
    expect(decided.approverUserId).toBe("owner-user");
    expect(decided.approvedAt).not.toBeNull();
  });

  it("cannot approve an approval that is not pending (no double-approval)", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "t1", requestedAction: "x", payloadDigest: "digest-1" }, store);
    await approveApproval("t1", approval.id, "owner-user", "owner", store);
    await expect(approveApproval("t1", approval.id, "owner-user", "owner", store)).rejects.toThrow(/not 'pending'/);
  });

  it("an owner can reject, with a reason recorded", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "t1", requestedAction: "x", payloadDigest: "digest-1" }, store);
    const decided = await rejectApproval("t1", approval.id, "owner-user", "owner", "too risky", store);
    expect(decided.status).toBe("rejected");
    expect(decided.reason).toBe("too risky");
  });

  it("staff cannot reject either", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "t1", requestedAction: "x", payloadDigest: "digest-1" }, store);
    await expect(rejectApproval("t1", approval.id, "user-1", "staff", undefined, store)).rejects.toThrow(/owner/);
  });

  it("an expired approval cannot be approved — it transitions to 'expired' instead", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval(
      { tenantId: "t1", requestedAction: "x", expiresAt: new Date(Date.now() - 1000).toISOString(), payloadDigest: "digest-1" },
      store
    );
    await expect(approveApproval("t1", approval.id, "owner-user", "owner", store)).rejects.toThrow(/expired/);
    const after = await store.getById("t1", approval.id);
    expect(after?.status).toBe("expired");
  });

  it("an expired approval cannot be rejected either — it transitions to 'expired', never 'rejected' (Codex review finding on PR #21)", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval(
      { tenantId: "t1", requestedAction: "x", expiresAt: new Date(Date.now() - 1000).toISOString(), payloadDigest: "digest-1" },
      store
    );
    await expect(rejectApproval("t1", approval.id, "owner-user", "owner", "too risky", store)).rejects.toThrow(/expired/);
    const after = await store.getById("t1", approval.id);
    expect(after?.status).toBe("expired");
    expect(after?.reason).toBeNull(); // the reject's own reason was never applied
  });

  it("a not-yet-expired pending approval can still be rejected normally", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval(
      { tenantId: "t1", requestedAction: "x", expiresAt: new Date(Date.now() + 60_000).toISOString(), payloadDigest: "digest-1" },
      store
    );
    const decided = await rejectApproval("t1", approval.id, "owner-user", "owner", "not needed", store);
    expect(decided.status).toBe("rejected");
  });

  it("an approval with no expiresAt is never treated as expired", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "t1", requestedAction: "x", payloadDigest: "digest-1" }, store);
    const decided = await rejectApproval("t1", approval.id, "owner-user", "owner", undefined, store);
    expect(decided.status).toBe("rejected");
  });
});

/**
 * Concurrent human decisions (fix for the independent-review B-03 follow-up
 * "approval decision is not atomic"). Before this fix, approveApproval/
 * rejectApproval read-then-wrote non-atomically — two concurrent calls
 * could both observe 'pending' and the last writer would silently win,
 * clobbering whichever decision landed first. store.decide() is now itself
 * a CAS (`WHERE status = 'pending'`), so approveApproval/rejectApproval's
 * prior getById() is diagnostic-only, never authoritative — see
 * lib/approvals/service.ts and lib/approvals/store.ts.
 */
describe("concurrent human decisions — exactly one CAS wins", () => {
  it("test 1: concurrent approve + reject — exactly one terminal decision wins", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "t1", requestedAction: "x", payloadDigest: "digest-1" }, store);

    const results = await Promise.allSettled([
      approveApproval("t1", approval.id, "owner-1", "owner", store),
      rejectApproval("t1", approval.id, "owner-1", "owner", "too risky", store),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The final, persisted state must match whichever decision actually
    // won — not silently be overwritten by the loser.
    const final = await store.getById("t1", approval.id);
    expect(final?.status === "approved" || final?.status === "rejected").toBe(true);
    if (fulfilled[0].status === "fulfilled") {
      expect(final?.status).toBe(fulfilled[0].value.status);
    }
  });

  it("test 2: concurrent approve + approve — only one CAS decision succeeds", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "t1", requestedAction: "x", payloadDigest: "digest-1" }, store);

    const results = await Promise.allSettled([
      approveApproval("t1", approval.id, "owner-1", "owner", store),
      approveApproval("t1", approval.id, "owner-2", "owner", store),
    ]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof approveApproval>>> => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/not 'pending'/);

    const final = await store.getById("t1", approval.id);
    expect(final?.status).toBe("approved");
    // The winner's recorded approver is the one that actually landed.
    expect(final?.approverUserId).toBe(fulfilled[0].value.approverUserId);
  });

  it("test 3: concurrent reject + reject — only one CAS decision succeeds", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "t1", requestedAction: "x", payloadDigest: "digest-1" }, store);

    const results = await Promise.allSettled([
      rejectApproval("t1", approval.id, "owner-1", "owner", "reason A", store),
      rejectApproval("t1", approval.id, "owner-2", "owner", "reason B", store),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const final = await store.getById("t1", approval.id);
    expect(final?.status).toBe("rejected");
    // Exactly one of the two reasons landed — never a mix, never both applied.
    expect(["reason A", "reason B"]).toContain(final?.reason);
  });

  it("a losing decide() call never overwrites the winner's fields (no last-writer-wins)", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "t1", requestedAction: "x", payloadDigest: "digest-1" }, store);

    await approveApproval("t1", approval.id, "owner-1", "owner", store);
    // A second, later decide() attempt against the now-non-pending approval
    // must be a pure no-op — not a partial field overwrite.
    const second = await store.decide("t1", approval.id, { status: "rejected", approverUserId: "owner-2", reason: "too late" });
    expect(second).toBeNull();

    const final = await store.getById("t1", approval.id);
    expect(final?.status).toBe("approved");
    expect(final?.approverUserId).toBe("owner-1");
    expect(final?.reason).toBeNull();
  });
});

/**
 * Authenticated human approval identity (P0.9 Slice C, finding M-02).
 * Production-facing entrypoints must resolve the acting human from trusted
 * session context — never trust a caller-supplied approverUserId/
 * approverRole. `resolveApprovalActor`'s resolveContext is injectable so
 * these tests never touch real Supabase auth.
 */
describe("authenticated approval identity (M-02)", () => {
  function fakeResolver(context: { tenantId: string; role: "owner" | "staff"; userId: string } | null): TenantContextResolver {
    return async () => context;
  }

  it("resolveApprovalActor returns the resolved actor when tenant membership matches", async () => {
    const actor = await resolveApprovalActor("tenant-a", fakeResolver({ tenantId: "tenant-a", role: "owner", userId: "user-1" }));
    expect(actor).toEqual({ userId: "user-1", tenantId: "tenant-a", role: "owner" });
  });

  it("resolveApprovalActor returns null when no session/context resolves at all", async () => {
    const actor = await resolveApprovalActor("tenant-a", fakeResolver(null));
    expect(actor).toBeNull();
  });

  it("resolveApprovalActor refuses a resolved context for a DIFFERENT tenant than the approval's own", async () => {
    // The caller is a genuine, authenticated owner — just of the WRONG
    // tenant. Must still be refused; a caller cannot act on an approval
    // belonging to a tenant they don't actually belong to.
    const actor = await resolveApprovalActor("tenant-a", fakeResolver({ tenantId: "tenant-b", role: "owner", userId: "user-1" }));
    expect(actor).toBeNull();
  });

  it("approveApprovalAsAuthenticatedActor approves using the RESOLVED identity, never a caller-supplied one", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "tenant-a", requestedAction: "x", payloadDigest: "digest-1" }, store);

    const decided = await approveApprovalAsAuthenticatedActor(
      "tenant-a",
      approval.id,
      store,
      fakeResolver({ tenantId: "tenant-a", role: "owner", userId: "resolved-user-1" })
    );
    expect(decided.status).toBe("approved");
    expect(decided.approverUserId).toBe("resolved-user-1");
  });

  it("approveApprovalAsAuthenticatedActor refuses outright when no actor can be resolved — never falls back to trusting anything caller-supplied", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "tenant-a", requestedAction: "x", payloadDigest: "digest-1" }, store);

    await expect(approveApprovalAsAuthenticatedActor("tenant-a", approval.id, store, fakeResolver(null))).rejects.toThrow(
      /no authenticated tenant member/
    );
    const stillPending = await store.getById("tenant-a", approval.id);
    expect(stillPending?.status).toBe("pending");
  });

  it("a resolved STAFF actor still cannot approve — the caller cannot self-declare 'owner' via any path", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "tenant-a", requestedAction: "x", payloadDigest: "digest-1" }, store);

    await expect(
      approveApprovalAsAuthenticatedActor("tenant-a", approval.id, store, fakeResolver({ tenantId: "tenant-a", role: "staff", userId: "user-2" }))
    ).rejects.toThrow(/owner/);
  });

  it("a cross-tenant authenticated actor cannot approve another tenant's approval, even as a genuine owner of their own tenant", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "tenant-a", requestedAction: "x", payloadDigest: "digest-1" }, store);

    await expect(
      approveApprovalAsAuthenticatedActor("tenant-a", approval.id, store, fakeResolver({ tenantId: "tenant-b", role: "owner", userId: "user-3" }))
    ).rejects.toThrow(/no authenticated tenant member/);
    const stillPending = await store.getById("tenant-a", approval.id);
    expect(stillPending?.status).toBe("pending");
  });

  it("rejectApprovalAsAuthenticatedActor mirrors the same resolved-identity boundary", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await requestApproval({ tenantId: "tenant-a", requestedAction: "x", payloadDigest: "digest-1" }, store);

    const decided = await rejectApprovalAsAuthenticatedActor(
      "tenant-a",
      approval.id,
      "not needed",
      store,
      fakeResolver({ tenantId: "tenant-a", role: "owner", userId: "resolved-user-1" })
    );
    expect(decided.status).toBe("rejected");
    expect(decided.approverUserId).toBe("resolved-user-1");
    expect(decided.reason).toBe("not needed");
  });
});
