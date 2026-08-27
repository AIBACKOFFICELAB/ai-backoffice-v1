import { describe, it, expect } from "vitest";
import { InMemoryApprovalStore } from "./store";
import { computePayloadDigest } from "./payloadBinding";

/**
 * Approval CAS + payload binding (Codex P0 audit finding B-03).
 * ACTUAL GUARANTEE under test (see docs/AGENT_SECURITY.md for the full
 * statement): at-most-one-concurrent-executor + single-use + payload-
 * bound. NOT exactly-once delivery to the tool — a tool execution that
 * fails after 'executing' is claimed still lands on 'executed' (terminal);
 * retrying requires a new approval. This suite tests the store-level CAS
 * primitives directly; lib/agents/runtime.test.ts exercises the same
 * guarantee through the full runtime (resumeAfterApprovalDecision).
 */

const baseBinding = {
  tenantId: "t1",
  agentId: "agent-1",
  agentRunId: "run-1",
  toolName: "draft_customer_message",
  action: "execute",
  payload: { draft: "Hi there" },
};

async function createApprovedApproval(store: InMemoryApprovalStore, overrides: Partial<typeof baseBinding> = {}) {
  const binding = { ...baseBinding, ...overrides };
  const digest = computePayloadDigest(binding);
  const approval = await store.create({
    tenantId: binding.tenantId,
    agentId: binding.agentId,
    agentRunId: binding.agentRunId,
    requestedAction: `${binding.toolName}.${binding.action}`,
    payload: binding.payload,
    payloadDigest: digest,
  });
  await store.decide(binding.tenantId, approval.id, { status: "approved" });
  return { approval, digest, binding };
}

describe("beginExecution — atomic, single-use, payload-bound claim", () => {
  it("claims an approved approval whose digest matches, moving it to 'executing'", async () => {
    const store = new InMemoryApprovalStore();
    const { approval, digest } = await createApprovedApproval(store);

    const claimed = await store.beginExecution("t1", approval.id, digest);
    expect(claimed).not.toBeNull();
    expect(claimed?.status).toBe("executing");
  });

  it("refuses a second claim on the same approval — two consumers, only one wins", async () => {
    const store = new InMemoryApprovalStore();
    const { approval, digest } = await createApprovedApproval(store);

    const first = await store.beginExecution("t1", approval.id, digest);
    const second = await store.beginExecution("t1", approval.id, digest);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("refuses when the recomputed digest doesn't match — payload mutated since approval", async () => {
    const store = new InMemoryApprovalStore();
    const { approval } = await createApprovedApproval(store);

    const tamperedDigest = computePayloadDigest({ ...baseBinding, payload: { draft: "Wire $10,000 immediately" } });
    const claimed = await store.beginExecution("t1", approval.id, tamperedDigest);
    expect(claimed).toBeNull();

    // Not silently consumed — still sitting in 'approved', available for a
    // legitimate (non-tampered) claim.
    const after = await store.getById("t1", approval.id);
    expect(after?.status).toBe("approved");
  });

  it("refuses a still-pending approval (no decision made yet)", async () => {
    const store = new InMemoryApprovalStore();
    const digest = computePayloadDigest(baseBinding);
    const approval = await store.create({ tenantId: "t1", requestedAction: "x", payload: baseBinding.payload, payloadDigest: digest });
    expect(await store.beginExecution("t1", approval.id, digest)).toBeNull();
  });

  it("refuses a rejected approval", async () => {
    const store = new InMemoryApprovalStore();
    const digest = computePayloadDigest(baseBinding);
    const approval = await store.create({ tenantId: "t1", requestedAction: "x", payload: baseBinding.payload, payloadDigest: digest });
    await store.decide("t1", approval.id, { status: "rejected" });
    expect(await store.beginExecution("t1", approval.id, digest)).toBeNull();
  });

  it("refuses an expired approval", async () => {
    const store = new InMemoryApprovalStore();
    const digest = computePayloadDigest(baseBinding);
    const approval = await store.create({ tenantId: "t1", requestedAction: "x", payload: baseBinding.payload, payloadDigest: digest });
    await store.decide("t1", approval.id, { status: "expired" });
    expect(await store.beginExecution("t1", approval.id, digest)).toBeNull();
  });

  it("refuses an already-executed approval (duplicate resume)", async () => {
    const store = new InMemoryApprovalStore();
    const { approval, digest } = await createApprovedApproval(store);
    await store.beginExecution("t1", approval.id, digest);
    await store.completeExecution("t1", approval.id, { ok: true });

    expect(await store.beginExecution("t1", approval.id, digest)).toBeNull();
  });

  it("wrong tenant: an approval cannot be claimed under a different tenant id", async () => {
    const store = new InMemoryApprovalStore();
    const { approval, digest } = await createApprovedApproval(store);
    expect(await store.beginExecution("t2", approval.id, digest)).toBeNull();
  });
});

describe("completeExecution — terminal, single-use", () => {
  it("transitions executing -> executed and records the outcome", async () => {
    const store = new InMemoryApprovalStore();
    const { approval, digest } = await createApprovedApproval(store);
    await store.beginExecution("t1", approval.id, digest);

    const done = await store.completeExecution("t1", approval.id, { ok: true, summary: { sent: true } });
    expect(done.status).toBe("executed");
    expect(done.executionResult).toEqual({ ok: true, summary: { sent: true } });
  });

  it("refuses to complete an approval that never entered 'executing'", async () => {
    const store = new InMemoryApprovalStore();
    const { approval } = await createApprovedApproval(store);
    await expect(store.completeExecution("t1", approval.id, { ok: true })).rejects.toThrow(/not 'executing'/);
  });

  it("a failed tool execution still lands on 'executed' (terminal) — this is the documented at-most-one-concurrent-executor guarantee, not exactly-once success", async () => {
    const store = new InMemoryApprovalStore();
    const { approval, digest } = await createApprovedApproval(store);
    await store.beginExecution("t1", approval.id, digest);

    const done = await store.completeExecution("t1", approval.id, { ok: false, error: "tool threw" });
    expect(done.status).toBe("executed");
    expect(done.executionResult).toEqual({ ok: false, error: "tool threw" });

    // Consumed — a retry needs a NEW approval, not a second claim on this one.
    expect(await store.beginExecution("t1", approval.id, digest)).toBeNull();
  });
});

describe("computePayloadDigest determinism", () => {
  it("is stable regardless of object key order", () => {
    const a = computePayloadDigest({ tenantId: "t1", agentId: "a", agentRunId: "r", toolName: "x", action: "y", payload: { a: 1, b: 2 } });
    const b = computePayloadDigest({ tenantId: "t1", agentId: "a", agentRunId: "r", toolName: "x", action: "y", payload: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });

  it("changes when any bound field changes — tenant, agent, run, tool, action, or payload", () => {
    const base = { tenantId: "t1", agentId: "a", agentRunId: "r", toolName: "x", action: "y", payload: { draft: "hi" } };
    const digest = computePayloadDigest(base);
    expect(computePayloadDigest({ ...base, tenantId: "t2" })).not.toBe(digest);
    expect(computePayloadDigest({ ...base, agentId: "b" })).not.toBe(digest);
    expect(computePayloadDigest({ ...base, agentRunId: "r2" })).not.toBe(digest);
    expect(computePayloadDigest({ ...base, toolName: "z" })).not.toBe(digest);
    expect(computePayloadDigest({ ...base, action: "y2" })).not.toBe(digest);
    expect(computePayloadDigest({ ...base, payload: { draft: "bye" } })).not.toBe(digest);
  });
});
