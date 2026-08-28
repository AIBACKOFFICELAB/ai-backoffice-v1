import { describe, it, expect } from "vitest";
import { InMemoryAgentStore } from "./agentStore";

/**
 * AgentStore.update() instructionsVersion advancement (P0.9 Slice B
 * correction 3). Before this correction, update() could silently change
 * system_instructions without ever advancing instructions_version — a
 * historical PolicySnapshot's agentInstructionsVersion could then report
 * the same number for genuinely different instruction sets. The numeric
 * version here is documented as best-effort, human-readable metadata (see
 * lib/agents/agentStore.ts); the authoritative historical identity is the
 * per-decision agentInstructionsHash on PolicySnapshot (see
 * lib/agents/permissions.test.ts for the hash-side tests of this same
 * correction).
 */
describe("AgentStore.update — instructionsVersion advances only on an actual instructions change (B-07 correction 3)", () => {
  it("test 6: instructionsVersion advances when systemInstructions is changed through update()", async () => {
    const store = new InMemoryAgentStore();
    const agent = await store.create({ tenantId: "t1", agentType: "dev_test", name: "A", systemInstructions: "v1 instructions" });
    expect(agent.instructionsVersion).toBe(1);

    const updated = await store.update("t1", agent.id, { systemInstructions: "v2 instructions" });
    expect(updated.instructionsVersion).toBe(2);
    expect(updated.systemInstructions).toBe("v2 instructions");
  });

  it("does NOT advance instructionsVersion when an unrelated field changes", async () => {
    const store = new InMemoryAgentStore();
    const agent = await store.create({ tenantId: "t1", agentType: "dev_test", name: "A", systemInstructions: "v1 instructions" });

    const updated = await store.update("t1", agent.id, { name: "Renamed", status: "active" });
    expect(updated.instructionsVersion).toBe(1);
    expect(updated.name).toBe("Renamed");
  });

  it("does NOT advance instructionsVersion when systemInstructions is included but set to the SAME value", async () => {
    const store = new InMemoryAgentStore();
    const agent = await store.create({ tenantId: "t1", agentType: "dev_test", name: "A", systemInstructions: "same instructions" });

    const updated = await store.update("t1", agent.id, { systemInstructions: "same instructions" });
    expect(updated.instructionsVersion).toBe(1);
  });

  it("advances instructionsVersion exactly once per genuine change across multiple updates", async () => {
    const store = new InMemoryAgentStore();
    const agent = await store.create({ tenantId: "t1", agentType: "dev_test", name: "A", systemInstructions: "v1" });

    await store.update("t1", agent.id, { systemInstructions: "v2" });
    await store.update("t1", agent.id, { name: "no-op for instructions" });
    const final = await store.update("t1", agent.id, { systemInstructions: "v3" });

    expect(final.instructionsVersion).toBe(3);
  });

  it("transitioning from null systemInstructions to a real string counts as a change", async () => {
    const store = new InMemoryAgentStore();
    const agent = await store.create({ tenantId: "t1", agentType: "dev_test", name: "A" });
    expect(agent.systemInstructions).toBeNull();
    expect(agent.instructionsVersion).toBe(1);

    const updated = await store.update("t1", agent.id, { systemInstructions: "now has instructions" });
    expect(updated.instructionsVersion).toBe(2);
  });
});
