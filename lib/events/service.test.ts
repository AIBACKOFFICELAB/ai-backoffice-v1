import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitEvent, emitEventSafely, getRecentEvents } from "./service";
import { InMemoryBusinessEventStore } from "./store";
import { TELEMETRY_DEADLINE_MS } from "@/lib/telemetry/deadline";

describe("emitEvent idempotency", () => {
  it("returns the same event and does not duplicate when idempotencyKey repeats", async () => {
    const store = new InMemoryBusinessEventStore();
    const first = await emitEvent({ tenantId: "t1", eventType: "call.missed", idempotencyKey: "call-sid-123" }, store);
    const second = await emitEvent({ tenantId: "t1", eventType: "call.missed", idempotencyKey: "call-sid-123" }, store);

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.event.id).toBe(first.event.id);
    expect(store.all()).toHaveLength(1);
  });

  it("does not dedupe events without an idempotencyKey", async () => {
    const store = new InMemoryBusinessEventStore();
    await emitEvent({ tenantId: "t1", eventType: "lead.created" }, store);
    await emitEvent({ tenantId: "t1", eventType: "lead.created" }, store);
    expect(store.all()).toHaveLength(2);
  });

  it("idempotency is scoped per tenant — same key, different tenant, both recorded", async () => {
    const store = new InMemoryBusinessEventStore();
    await emitEvent({ tenantId: "t1", eventType: "call.missed", idempotencyKey: "shared-key" }, store);
    await emitEvent({ tenantId: "t2", eventType: "call.missed", idempotencyKey: "shared-key" }, store);
    expect(store.all()).toHaveLength(2);
  });

  it("rejects emission without tenantId or eventType", async () => {
    const store = new InMemoryBusinessEventStore();
    await expect(emitEvent({ tenantId: "", eventType: "x" }, store)).rejects.toThrow();
    await expect(emitEvent({ tenantId: "t1", eventType: "" }, store)).rejects.toThrow();
  });
});

describe("emitEventSafely", () => {
  it("never throws, even when the underlying store fails — returns null, not the event", async () => {
    const failingStore = {
      insert: async () => {
        throw new Error("boom");
      },
      listByTenant: async () => [],
      getById: async () => null,
    };
    await expect(emitEventSafely({ tenantId: "t1", eventType: "call.missed" }, failingStore)).resolves.toBeNull();
  });

  it("returns the recorded event on success, so callers can chain correlation/causation", async () => {
    const store = new InMemoryBusinessEventStore();
    const event = await emitEventSafely({ tenantId: "t1", eventType: "lead.created", entityId: "lead-1" }, store);
    expect(event?.eventType).toBe("lead.created");
    expect(event?.entityId).toBe("lead-1");
  });
});

/**
 * Compatibility telemetry deadline (P0.9 Slice C, finding H-01). These
 * exercise emitEventSafely directly with an injected fake store — proving
 * the "legacy flow continues regardless" invariant at the unit level, which
 * is what the calling legacy module (lib/modules/missedCallRecovery) relies
 * on: since `await emitEventSafely(...)` never throws (before or after this
 * change) and its call sites are otherwise unmodified, this invariant holds
 * for every caller by construction, not just in this test file.
 */
describe("emitEventSafely — compatibility telemetry deadline (H-01)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scenario: event store rejects -> emitEventSafely resolves null, legacy flow continues", async () => {
    const rejectingStore = {
      insert: async () => {
        throw new Error("connection refused");
      },
      listByTenant: async () => [],
      getById: async () => null,
    };
    const resultPromise = emitEventSafely({ tenantId: "t1", eventType: "call.missed" }, rejectingStore);
    await vi.advanceTimersByTimeAsync(10);
    await expect(resultPromise).resolves.toBeNull();
  });

  it("scenario: event store never resolves -> emitEventSafely resolves null after the bounded deadline, not indefinitely", async () => {
    const hangingStore = {
      insert: () => new Promise<never>(() => {}),
      listByTenant: async () => [],
      getById: async () => null,
    };
    const resultPromise = emitEventSafely({ tenantId: "t1", eventType: "call.missed" }, hangingStore);

    let settled = false;
    resultPromise.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(TELEMETRY_DEADLINE_MS - 1);
    await Promise.resolve();
    expect(settled).toBe(false); // still within the deadline — must not have given up early

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
        getById: async () => null,
      };
      await emitEventSafely({ tenantId: "t1", eventType: "call.missed" }, rejectingStore);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toHaveLength(0);
  });
});

describe("getRecentEvents", () => {
  it("filters by eventType and respects limit", async () => {
    const store = new InMemoryBusinessEventStore();
    await emitEvent({ tenantId: "t1", eventType: "lead.created" }, store);
    await emitEvent({ tenantId: "t1", eventType: "call.missed" }, store);
    await emitEvent({ tenantId: "t1", eventType: "call.missed" }, store);

    const missedCalls = await getRecentEvents("t1", { eventType: "call.missed" }, store);
    expect(missedCalls).toHaveLength(2);
    expect(missedCalls.every((e) => e.eventType === "call.missed")).toBe(true);

    const limited = await getRecentEvents("t1", { limit: 1 }, store);
    expect(limited).toHaveLength(1);
  });
});
