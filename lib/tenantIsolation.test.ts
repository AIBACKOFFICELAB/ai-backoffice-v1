import { describe, it, expect } from "vitest";
import { InMemoryBusinessEventStore } from "./events/store";
import { InMemoryAgentStore } from "./agents/agentStore";
import { InMemoryAgentRunStore } from "./agents/runStore";
import { InMemoryToolCallStore } from "./agents/toolCallStore";
import { InMemoryApprovalStore } from "./approvals/store";
import { InMemoryOutcomeStore } from "./outcomes/store";
import { InMemoryDurableJobStore } from "./execution/store";

/**
 * Tenant isolation (P0 required test). Every new P0 store filters strictly
 * by tenant_id — application code uses the service-role Supabase client
 * (see lib/supabase/server.ts), which bypasses RLS, so this explicit
 * filtering IS the actual isolation mechanism in production, not just a
 * backstop (see docs/constitution/06_DATABASE_PRINCIPLES.md and
 * docs/AGENT_SECURITY.md). The in-memory stores implement the identical
 * interface — and identical tenant_id filtering — as their Supabase-backed
 * counterparts, so this test exercises the real contract every caller
 * depends on.
 */

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

describe("tenant isolation", () => {
  it("business_events: a tenant never sees another tenant's events", async () => {
    const store = new InMemoryBusinessEventStore();
    const { event: eventA } = await store.insert({ tenantId: TENANT_A, eventType: "test.echo" });
    await store.insert({ tenantId: TENANT_B, eventType: "test.echo" });

    const listA = await store.listByTenant(TENANT_A);
    expect(listA).toHaveLength(1);
    expect(listA[0].tenantId).toBe(TENANT_A);

    expect(await store.getById(TENANT_B, eventA.id)).toBeNull();
  });

  it("agents: listing/getting under the wrong tenant never returns another tenant's agent", async () => {
    const store = new InMemoryAgentStore();
    const agentA = await store.create({ tenantId: TENANT_A, agentType: "dev_test", name: "A" });
    await store.create({ tenantId: TENANT_B, agentType: "dev_test", name: "B" });

    expect(await store.listByTenant(TENANT_A)).toHaveLength(1);
    expect(await store.getById(TENANT_B, agentA.id)).toBeNull();
  });

  it("agent_runs: cannot be fetched or updated across a tenant boundary", async () => {
    const store = new InMemoryAgentRunStore();
    const runA = await store.create({ tenantId: TENANT_A, agentId: "agent-a" });

    expect(await store.getById(TENANT_B, runA.id)).toBeNull();
    await expect(store.update(TENANT_B, runA.id, { status: "failed" })).rejects.toThrow();
  });

  const stubPolicySnapshot = {
    snapshotVersion: 1 as const,
    toolName: "ping",
    action: "execute",
    intrinsicPermission: "EXECUTE" as const,
    toolDefinitionVersion: 1,
    resolvedTier: "AUTO_EXECUTE" as const,
    decision: "allow" as const,
    reason: null,
    agentInstructionsVersion: 1,
    agentConfiguredTier: "AUTO_EXECUTE" as const,
    requiredReadScopes: [],
    requiredWriteScopes: [],
    agentReadScopes: [],
    agentWriteScopes: [],
    evaluatedAt: new Date().toISOString(),
  };

  it("tool_calls: scoped per tenant, including approval-id lookup", async () => {
    const store = new InMemoryToolCallStore();
    const tcA = await store.create({
      tenantId: TENANT_A,
      agentRunId: "run-a",
      toolName: "ping",
      action: "execute",
      requestSummary: {},
      policySnapshot: stubPolicySnapshot,
    });
    await store.update(TENANT_A, tcA.id, { approvalId: "approval-a" });

    expect(await store.getByApprovalId(TENANT_B, "approval-a")).toBeNull();
    expect(await store.listByAgentRun(TENANT_B, "run-a")).toHaveLength(0);
  });

  it("approvals: pending list and decisions are tenant-scoped", async () => {
    const store = new InMemoryApprovalStore();
    const approvalA = await store.create({ tenantId: TENANT_A, requestedAction: "draft_customer_message.execute", payloadDigest: "digest-a" });
    await store.create({ tenantId: TENANT_B, requestedAction: "draft_customer_message.execute", payloadDigest: "digest-b" });

    expect(await store.listByTenant(TENANT_A, { status: "pending" })).toHaveLength(1);
    // decide() is a CAS (see lib/approvals/store.ts) — it never throws for
    // "not found under this tenant," it returns null, same as any other
    // failed claim. Cross-tenant is still fully blocked either way.
    expect(await store.decide(TENANT_B, approvalA.id, { status: "approved" })).toBeNull();
    const stillPendingForA = await store.getById(TENANT_A, approvalA.id);
    expect(stillPendingForA?.status).toBe("pending");
  });

  it("outcomes: revenue/attribution rows never leak across tenants", async () => {
    const store = new InMemoryOutcomeStore();
    await store.insert({ tenantId: TENANT_A, outcomeType: "lead_recovered", attributionConfidence: "direct", outcomeValue: 500 });
    await store.insert({ tenantId: TENANT_B, outcomeType: "lead_recovered", attributionConfidence: "direct", outcomeValue: 999999 });

    const listA = await store.listByTenant(TENANT_A);
    expect(listA).toHaveLength(1);
    expect(listA[0].outcomeValue).toBe(500);
  });

  it("durable_jobs: claiming for one tenant's job never exposes another tenant's queue", async () => {
    const store = new InMemoryDurableJobStore();
    await store.enqueue({ tenantId: TENANT_A, jobType: "diagnostic.echo" });
    await store.enqueue({ tenantId: TENANT_B, jobType: "diagnostic.echo" });

    expect(await store.listByTenant(TENANT_A)).toHaveLength(1);
    expect(await store.listByTenant(TENANT_B)).toHaveLength(1);
  });
});
