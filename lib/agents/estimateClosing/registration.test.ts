import { describe, it, expect } from "vitest";
import { ensureEstimateClosingAgent } from "./registration";
import { InMemoryAgentStore } from "../agentStore";

/**
 * P1 Sprint 2 — dedicated Estimate Closing Agent registration. Proves the
 * exact safety contract the directive requires: inactive by default, zero
 * capability, idempotent, tenant-isolated, and no side effect on any other
 * agent row (in particular, never a dev_test/supervisor row — the reason
 * this function exists instead of reusing seedAgents).
 */
describe("ensureEstimateClosingAgent", () => {
  it("first call creates exactly one inactive estimate_closing agent", async () => {
    const store = new InMemoryAgentStore();
    const { agent, created } = await ensureEstimateClosingAgent("tenant-1", store);

    expect(created).toBe(true);
    expect(agent.tenantId).toBe("tenant-1");
    expect(agent.agentType).toBe("estimate_closing");
    expect(agent.name).toBe("Estimate Closing Agent");
    expect(agent.status).toBe("inactive");
  });

  it("second call is idempotent — same row, created: false, no duplicate", async () => {
    const store = new InMemoryAgentStore();
    const first = await ensureEstimateClosingAgent("tenant-1", store);
    const second = await ensureEstimateClosingAgent("tenant-1", store);

    expect(second.created).toBe(false);
    expect(second.agent.id).toBe(first.agent.id);

    const all = await store.listByTenant("tenant-1", { agentType: "estimate_closing" });
    expect(all).toHaveLength(1);
  });

  it("two 'concurrent' calls for the same tenant still produce exactly one row", async () => {
    const store = new InMemoryAgentStore();
    const [a, b] = await Promise.all([ensureEstimateClosingAgent("tenant-2", store), ensureEstimateClosingAgent("tenant-2", store)]);

    expect(a.agent.id).toBe(b.agent.id);
    const all = await store.listByTenant("tenant-2", { agentType: "estimate_closing" });
    expect(all).toHaveLength(1);
  });

  it("tenant A and tenant B remain isolated — each gets its own row", async () => {
    const store = new InMemoryAgentStore();
    const a = await ensureEstimateClosingAgent("tenant-a", store);
    const b = await ensureEstimateClosingAgent("tenant-b", store);

    expect(a.agent.id).not.toBe(b.agent.id);
    expect(a.agent.tenantId).toBe("tenant-a");
    expect(b.agent.tenantId).toBe("tenant-b");
  });

  it("has no tools, no write scopes, and an empty approval policy", async () => {
    const store = new InMemoryAgentStore();
    const { agent } = await ensureEstimateClosingAgent("tenant-1", store);

    expect(agent.allowedTools).toEqual([]);
    expect(agent.writeScopes).toEqual([]);
    expect(agent.approvalPolicy).toEqual({});
  });

  it("never creates a dev_test or supervisor row as a side effect", async () => {
    const store = new InMemoryAgentStore();
    await ensureEstimateClosingAgent("tenant-1", store);

    const all = await store.listByTenant("tenant-1");
    expect(all).toHaveLength(1);
    expect(all.every((a) => a.agentType === "estimate_closing")).toBe(true);
    expect(all.some((a) => a.agentType === "dev_test")).toBe(false);
    expect(all.some((a) => a.agentType === "supervisor")).toBe(false);
  });
});
