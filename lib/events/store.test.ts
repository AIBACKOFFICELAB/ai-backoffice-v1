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

/**
 * P1 Sprint 6 final hardening (PR #25) — `offset` paging, added so a
 * caller needing an EXHAUSTIVE read (more rows than any single bounded
 * `limit` should request) can page through results without a single
 * fixed-size read silently truncating. See
 * lib/agents/estimateClosing/commercialEvidence.ts::fetchFollowThroughEventsForRecommendations,
 * the first real caller.
 */
describe("BusinessEventStore.listByTenant — offset paging", () => {
  it("pages through all rows with no gap or duplicate, using limit+offset", async () => {
    const store = new InMemoryBusinessEventStore();
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const { event } = await store.insert({ tenantId: "t1", eventType: "test.echo", occurredAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString(), payload: {} });
      ids.push(event.id);
    }

    const collected: string[] = [];
    let offset = 0;
    const pageSize = 7;
    while (true) {
      const page = await store.listByTenant("t1", { limit: pageSize, offset });
      collected.push(...page.map((e) => e.id));
      if (page.length < pageSize) break;
      offset += pageSize;
    }

    expect(collected).toHaveLength(25);
    expect(new Set(collected).size).toBe(25); // no duplicates
    expect(new Set(collected)).toEqual(new Set(ids)); // no gaps
  });

  it("uses a stable (occurredAt DESC, id DESC) order so ties never cause a row to be skipped or duplicated across a page boundary", async () => {
    const store = new InMemoryBusinessEventStore();
    // All ten rows share the EXACT same occurredAt — only `id` can break
    // the tie deterministically.
    const SAME_INSTANT = "2026-01-01T00:00:00.000Z";
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { event } = await store.insert({ tenantId: "t1", eventType: "test.echo", occurredAt: SAME_INSTANT, payload: {} });
      ids.push(event.id);
    }

    const page1 = await store.listByTenant("t1", { limit: 4, offset: 0 });
    const page2 = await store.listByTenant("t1", { limit: 4, offset: 4 });
    const page3 = await store.listByTenant("t1", { limit: 4, offset: 8 });

    const collected = [...page1, ...page2, ...page3].map((e) => e.id);
    expect(collected).toHaveLength(10);
    expect(new Set(collected).size).toBe(10);
    expect(new Set(collected)).toEqual(new Set(ids));
  });

  it("without offset, behaves exactly as before (a plain bounded limit read)", async () => {
    const store = new InMemoryBusinessEventStore();
    for (let i = 0; i < 5; i++) {
      await store.insert({ tenantId: "t1", eventType: "test.echo", occurredAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 1000).toISOString(), payload: {} });
    }
    const result = await store.listByTenant("t1", { limit: 3 });
    expect(result).toHaveLength(3);
  });
});
