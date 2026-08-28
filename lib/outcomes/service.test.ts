import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recordOutcome, recordOutcomeSafely, summarizeOutcomeValue } from "./service";
import { InMemoryOutcomeStore } from "./store";
import { TELEMETRY_DEADLINE_MS } from "@/lib/telemetry/deadline";

describe("recordOutcome validation", () => {
  it("rejects without tenantId, outcomeType, or attributionConfidence", async () => {
    const store = new InMemoryOutcomeStore();
    await expect(recordOutcome({ tenantId: "", outcomeType: "admin_time_saved", attributionConfidence: "direct" }, store)).rejects.toThrow();
    // @ts-expect-error deliberately omitting outcomeType to test the guard
    await expect(recordOutcome({ tenantId: "t1", attributionConfidence: "direct" }, store)).rejects.toThrow();
    // @ts-expect-error deliberately omitting attributionConfidence to test the guard
    await expect(recordOutcome({ tenantId: "t1", outcomeType: "admin_time_saved" }, store)).rejects.toThrow();
  });

  it("rejects a negative outcomeValue", async () => {
    const store = new InMemoryOutcomeStore();
    await expect(recordOutcome({ tenantId: "t1", outcomeType: "admin_time_saved", attributionConfidence: "direct", outcomeValue: -1 }, store)).rejects.toThrow(
      /cannot be negative/
    );
  });
});

/**
 * Outcome deduplication (P0.9 Slice C, finding C.3): a repeated webhook,
 * event replay, retry, or compatibility callback for the same logical
 * evidence must not create a duplicate outcome.
 */
describe("recordOutcome idempotency (C.3)", () => {
  it("returns the same outcome and does not duplicate when idempotencyKey repeats", async () => {
    const store = new InMemoryOutcomeStore();
    const first = await recordOutcome(
      { tenantId: "t1", outcomeType: "lead_recovered", attributionConfidence: "direct", idempotencyKey: "lead-recovered:lead-1:reply:msg-1" },
      store
    );
    const second = await recordOutcome(
      { tenantId: "t1", outcomeType: "lead_recovered", attributionConfidence: "direct", idempotencyKey: "lead-recovered:lead-1:reply:msg-1" },
      store
    );

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.outcome.id).toBe(first.outcome.id);
    expect(await store.listByTenant("t1")).toHaveLength(1);
  });

  it("does not dedupe outcomes without an idempotencyKey", async () => {
    const store = new InMemoryOutcomeStore();
    await recordOutcome({ tenantId: "t1", outcomeType: "admin_time_saved", attributionConfidence: "direct" }, store);
    await recordOutcome({ tenantId: "t1", outcomeType: "admin_time_saved", attributionConfidence: "direct" }, store);
    expect(await store.listByTenant("t1")).toHaveLength(2);
  });

  it("idempotency is scoped per tenant — same key, different tenant, both recorded", async () => {
    const store = new InMemoryOutcomeStore();
    await recordOutcome({ tenantId: "t1", outcomeType: "lead_recovered", attributionConfidence: "direct", idempotencyKey: "shared-key" }, store);
    await recordOutcome({ tenantId: "t2", outcomeType: "lead_recovered", attributionConfidence: "direct", idempotencyKey: "shared-key" }, store);
    expect(await store.listByTenant("t1")).toHaveLength(1);
    expect(await store.listByTenant("t2")).toHaveLength(1);
  });
});

/**
 * Compatibility telemetry deadline (P0.9 Slice C, finding H-01) — same
 * discipline and same reasoning as lib/events/service.test.ts.
 */
describe("recordOutcomeSafely — compatibility telemetry deadline (H-01)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scenario: outcome store rejects -> recordOutcomeSafely resolves null, legacy flow continues", async () => {
    const rejectingStore = {
      insert: async () => {
        throw new Error("connection refused");
      },
      listByTenant: async () => [],
    };
    const resultPromise = recordOutcomeSafely({ tenantId: "t1", outcomeType: "admin_time_saved", attributionConfidence: "direct" }, rejectingStore);
    await vi.advanceTimersByTimeAsync(10);
    await expect(resultPromise).resolves.toBeNull();
  });

  it("scenario: outcome store never resolves -> recordOutcomeSafely resolves null after the bounded deadline, not indefinitely", async () => {
    const hangingStore = {
      insert: () => new Promise<never>(() => {}),
      listByTenant: async () => [],
    };
    const resultPromise = recordOutcomeSafely({ tenantId: "t1", outcomeType: "admin_time_saved", attributionConfidence: "direct" }, hangingStore);

    let settled = false;
    resultPromise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(TELEMETRY_DEADLINE_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await expect(resultPromise).resolves.toBeNull();
  });

  it("scenario: no unhandled promise rejection when the store rejects", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const rejectingStore = {
        insert: async () => {
          throw new Error("boom");
        },
        listByTenant: async () => [],
      };
      await recordOutcomeSafely({ tenantId: "t1", outcomeType: "admin_time_saved", attributionConfidence: "direct" }, rejectingStore);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toHaveLength(0);
  });
});

describe("summarizeOutcomeValue", () => {
  it("sums by attribution tier, keeping tiers separate", () => {
    const totals = summarizeOutcomeValue([
      { id: "1", tenantId: "t1", workflowId: null, agentRunId: null, entityType: null, entityId: null, outcomeType: "revenue_recovered", outcomeValue: 100, currency: "USD", attributionConfidence: "direct", occurredAt: "", metadata: {}, idempotencyKey: null, createdAt: "" },
      { id: "2", tenantId: "t1", workflowId: null, agentRunId: null, entityType: null, entityId: null, outcomeType: "revenue_recovered", outcomeValue: 50, currency: "USD", attributionConfidence: "inferred", occurredAt: "", metadata: {}, idempotencyKey: null, createdAt: "" },
    ]);
    expect(totals).toEqual({ direct: 100, assisted: 0, inferred: 50, unknown: 0 });
  });
});
