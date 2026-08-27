import { describe, it, expect } from "vitest";
import { requestApproval, approveApproval, rejectApproval, listPendingApprovals } from "./service";
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
});
