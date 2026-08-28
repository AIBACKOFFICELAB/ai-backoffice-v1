import { describe, it, expect } from "vitest";
import { seedAgents } from "./seed";
import { InMemoryAgentStore } from "./agentStore";

/**
 * Concurrency-safe built-in agent identity (Codex P0 audit finding M-03).
 * InMemoryAgentStore.create enforces the same (tenant_id, agent_type)
 * uniqueness migration 017's uq_agents_tenant_builtin_type partial index
 * enforces in production (see agentStore.ts) — this is what makes these
 * tests exercise the real conflict-handling contract, not a re-implemented
 * approximation of it.
 */
describe("seedAgents — idempotent, concurrency-safe (M-03)", () => {
  it("calling seedAgents twice in sequence for the same tenant creates exactly one of each built-in agent", async () => {
    const store = new InMemoryAgentStore();
    const first = await seedAgents("tenant-1", store);
    const second = await seedAgents("tenant-1", store);

    expect(second.devTest.id).toBe(first.devTest.id);
    expect(second.supervisor.id).toBe(first.supervisor.id);

    const all = await store.listByTenant("tenant-1");
    expect(all.filter((a) => a.agentType === "dev_test")).toHaveLength(1);
    expect(all.filter((a) => a.agentType === "supervisor")).toHaveLength(1);
  });

  it("two 'concurrent' seedAgents calls for the same tenant still produce exactly one of each agent", async () => {
    const store = new InMemoryAgentStore();
    const [a, b] = await Promise.all([seedAgents("tenant-2", store), seedAgents("tenant-2", store)]);

    // Both calls must agree on the same winning rows — no duplicate,
    // no error, no silently different agents.
    expect(a.devTest.id).toBe(b.devTest.id);
    expect(a.supervisor.id).toBe(b.supervisor.id);

    const all = await store.listByTenant("tenant-2");
    expect(all.filter((r) => r.agentType === "dev_test")).toHaveLength(1);
    expect(all.filter((r) => r.agentType === "supervisor")).toHaveLength(1);
  });

  it("seeding is isolated per tenant — two tenants each get their own pair", async () => {
    const store = new InMemoryAgentStore();
    const t1 = await seedAgents("tenant-a", store);
    const t2 = await seedAgents("tenant-b", store);

    expect(t1.devTest.id).not.toBe(t2.devTest.id);
    expect(t1.devTest.tenantId).toBe("tenant-a");
    expect(t2.devTest.tenantId).toBe("tenant-b");
  });

  it("the underlying uniqueness constraint does not block multiple 'custom' agents for the same tenant", async () => {
    const store = new InMemoryAgentStore();
    const custom1 = await store.create({ tenantId: "tenant-1", agentType: "custom", name: "Custom A" });
    const custom2 = await store.create({ tenantId: "tenant-1", agentType: "custom", name: "Custom B" });
    expect(custom1.id).not.toBe(custom2.id);

    const all = await store.listByTenant("tenant-1", { agentType: "custom" });
    expect(all).toHaveLength(2);
  });

  it("a direct duplicate create() for a built-in type throws a unique-violation-shaped error (the constraint createIfAbsent relies on)", async () => {
    const store = new InMemoryAgentStore();
    await store.create({ tenantId: "tenant-1", agentType: "dev_test", name: "First" });
    await expect(store.create({ tenantId: "tenant-1", agentType: "dev_test", name: "Second" })).rejects.toMatchObject({ code: "23505" });
  });
});
