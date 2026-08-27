import { describe, it, expect } from "vitest";
import { emitEvent, emitEventSafely, getRecentEvents } from "./service";
import { InMemoryBusinessEventStore } from "./store";

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
  it("never throws, even when the underlying store fails", async () => {
    const failingStore = {
      insert: async () => {
        throw new Error("boom");
      },
      listByTenant: async () => [],
      getById: async () => null,
    };
    await expect(emitEventSafely({ tenantId: "t1", eventType: "call.missed" }, failingStore)).resolves.toBeUndefined();
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
