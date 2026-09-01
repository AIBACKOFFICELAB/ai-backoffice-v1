import { describe, it, expect } from "vitest";
import { InMemoryBusinessEventStore } from "./store";

/**
 * P1 Sprint 3 — `causationIdIn` (Codex review finding on PR #21): lets a
 * caller fetch events scoped to a specific, already-known set of related
 * event ids, instead of an independent recency `limit` that can silently
 * mismatch two bounded reads of related-but-different event types. See
 * lib/agents/estimateClosing/evaluationReadModel.ts's
 * listEstimateClosingRecommendationReviews, the first real caller.
 */
describe("BusinessEventStore.listByTenant — causationIdIn", () => {
  it("returns only events whose causationId is in the given set", async () => {
    const store = new InMemoryBusinessEventStore();
    const { event: a } = await store.insert({ tenantId: "t1", eventType: "test.echo", causationId: "cause-A", payload: {} });
    const { event: b } = await store.insert({ tenantId: "t1", eventType: "test.echo", causationId: "cause-B", payload: {} });
    await store.insert({ tenantId: "t1", eventType: "test.echo", causationId: "cause-C", payload: {} });

    const result = await store.listByTenant("t1", { causationIdIn: ["cause-A", "cause-B"] });
    expect(result.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("returns an empty array for an empty causationIdIn, never falling back to an unfiltered read", async () => {
    const store = new InMemoryBusinessEventStore();
    await store.insert({ tenantId: "t1", eventType: "test.echo", causationId: "cause-A", payload: {} });
    const result = await store.listByTenant("t1", { causationIdIn: [] });
    expect(result).toEqual([]);
  });

  it("excludes an event with a null causationId even if its id happens to be requested", async () => {
    const store = new InMemoryBusinessEventStore();
    const { event: noCausation } = await store.insert({ tenantId: "t1", eventType: "test.echo", payload: {} });
    const result = await store.listByTenant("t1", { causationIdIn: [noCausation.id] });
    expect(result).toEqual([]);
  });

  it("is not truncated by the default limit of 50 when more than 50 ids are requested", async () => {
    const store = new InMemoryBusinessEventStore();
    const causationIds: string[] = [];
    for (let i = 0; i < 75; i++) {
      const { event } = await store.insert({ tenantId: "t1", eventType: "test.echo", causationId: `cause-${i}`, payload: {} });
      causationIds.push(event.causationId!);
    }
    const result = await store.listByTenant("t1", { causationIdIn: causationIds });
    expect(result).toHaveLength(75);
  });

  it("combines with eventType and stays tenant-scoped", async () => {
    const store = new InMemoryBusinessEventStore();
    await store.insert({ tenantId: "t1", eventType: "test.echo", causationId: "cause-A", payload: {} });
    await store.insert({ tenantId: "t1", eventType: "lead.created", causationId: "cause-A", payload: {} });
    await store.insert({ tenantId: "t2", eventType: "test.echo", causationId: "cause-A", payload: {} });

    const result = await store.listByTenant("t1", { eventType: "test.echo", causationIdIn: ["cause-A"] });
    expect(result).toHaveLength(1);
    expect(result[0].eventType).toBe("test.echo");
    expect(result[0].tenantId).toBe("t1");
  });
});
