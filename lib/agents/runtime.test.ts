import { describe, it, expect } from "vitest";
import { runAgent, resumeAfterApprovalDecision } from "./runtime";
import { seedAgents } from "./seed";
import { InMemoryAgentStore } from "./agentStore";
import { InMemoryAgentRunStore } from "./runStore";
import { InMemoryToolCallStore } from "./toolCallStore";
import { DEFAULT_TOOL_REGISTRY } from "./toolRegistry";
import { InMemoryApprovalStore } from "@/lib/approvals/store";
import { approveApproval } from "@/lib/approvals/service";
import { InMemoryBusinessEventStore } from "@/lib/events/store";
import { emitEvent } from "@/lib/events/service";
import { AiGateway } from "@/lib/ai/gateway";
import { InMemoryModelInvocationStore } from "@/lib/ai/store";
import { MockChatProvider } from "@/lib/ai/providers/mock";
import { recordOutcome } from "@/lib/outcomes/service";
import { InMemoryOutcomeStore } from "@/lib/outcomes/store";

/**
 * P0 end-to-end demonstration (directive §15 exit criteria):
 *
 *   business event -> event recorded -> runtime invoked -> context (agent)
 *   retrieved -> model gateway invoked -> agent policy evaluated ->
 *   mock/safe tool called -> tool call recorded -> result verified ->
 *   agent run completed -> outcome recorded
 *
 * Entirely in-memory/mocked: tenant-safe (every store is tenant-scoped),
 * observable (every step produces an inspectable row), replay-resistant
 * (the triggering event and every tool call carry idempotency semantics
 * tested elsewhere), permission-aware (goes through the same
 * evaluateToolCall policy engine production code uses), provider-independent
 * (the gateway doesn't know or care that the provider is a mock), and
 * recoverable after failure (the awaiting_approval -> resume path below).
 */
describe("P0 end-to-end: business event -> agent run -> outcome", () => {
  it("runs the full chain, including the approval-gated tool completing after human sign-off", async () => {
    const tenantId = "tenant-e2e";

    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const eventStore = new InMemoryBusinessEventStore();
    const outcomeStore = new InMemoryOutcomeStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });

    // 1. Business event occurs and is recorded.
    const { event } = await emitEvent({ tenantId, eventType: "test.echo", payload: { note: "P0 demonstration" } }, eventStore);
    expect(event.id).toBeTruthy();

    // 2. Context: the dev/test agent is registered for this tenant.
    const { devTest } = await seedAgents(tenantId, agentStore);
    expect(devTest.status).toBe("active");

    // 3. Runtime invoked: model gateway called, policy evaluated per planned
    //    tool call, mock/safe tools executed.
    const { agentRun, toolCallOutcomes } = await runAgent(
      {
        tenantId,
        agentId: devTest.id,
        triggerEventId: event.id,
        workflowId: "p0-e2e-demo",
        reasoning: { prompt: "Confirm the AI BackOffice agent runtime is working." },
        toolPlan: [
          { toolName: "ping", action: "execute", input: {} },
          { toolName: "create_internal_note", action: "execute", input: { note: "runtime verified" } },
          { toolName: "draft_customer_message", action: "execute", input: { draft: "Hi, following up on your estimate." } },
        ],
      },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY }
    );

    expect(agentRun.triggerEventId).toBe(event.id);
    expect(agentRun.modelStrategy).toMatchObject({ provider: "mock", taskType: "reason" });

    const [pingOutcome, noteOutcome, draftOutcome] = toolCallOutcomes;
    expect(pingOutcome.toolCall.status).toBe("succeeded");
    expect(noteOutcome.toolCall.status).toBe("succeeded");
    expect(draftOutcome.toolCall.status).toBe("requires_approval");
    expect(draftOutcome.approval?.status).toBe("pending");

    // AUTO_EXECUTE + AUTO_EXECUTE_AND_LOG tools ran; the REQUIRE_APPROVAL one
    // is still pending, so the run as a whole is not yet complete.
    expect(agentRun.status).toBe("awaiting_approval");

    // 4. A human (tenant owner) approves the gated action.
    const decided = await approveApproval(tenantId, draftOutcome.approval!.id, "owner-user-1", "owner", approvalStore);
    expect(decided.status).toBe("approved");

    // 5. Resuming executes the tool and completes the run — this is the
    //    "recoverable after failure/interruption" leg of the exit criteria:
    //    the run picks back up from durable state, not in-memory context.
    const executed = await resumeAfterApprovalDecision(tenantId, draftOutcome.approval!.id, {
      agentStore,
      runStore,
      toolCallStore,
      approvalStore,
      gateway,
      tools: DEFAULT_TOOL_REGISTRY,
    });
    expect(executed.status).toBe("succeeded");
    expect(executed.responseSummary).toMatchObject({ draft: "Hi, following up on your estimate." });

    const finalRun = await runStore.getById(tenantId, agentRun.id);
    expect(finalRun?.status).toBe("succeeded");
    expect(finalRun?.completedAt).not.toBeNull();

    // 6. Outcome recorded against the completed run.
    const outcome = await recordOutcome(
      {
        tenantId,
        agentRunId: agentRun.id,
        workflowId: "p0-e2e-demo",
        outcomeType: "admin_time_saved",
        attributionConfidence: "direct",
        metadata: { note: "P0 exit-criteria demonstration run" },
      },
      outcomeStore
    );
    expect(outcome.agentRunId).toBe(agentRun.id);
    expect(await outcomeStore.listByTenant(tenantId)).toHaveLength(1);
  });

  it("denies a HUMAN_ONLY-tier tool outright instead of queuing it for approval", async () => {
    const tenantId = "tenant-e2e-2";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });

    const agent = await agentStore.create({
      tenantId,
      agentType: "dev_test",
      name: "Restricted agent",
      status: "active",
      allowedTools: ["ping"],
      approvalPolicy: { ping: "HUMAN_ONLY" },
    });

    const { toolCallOutcomes, agentRun } = await runAgent(
      {
        tenantId,
        agentId: agent.id,
        reasoning: { prompt: "test" },
        toolPlan: [{ toolName: "ping", action: "execute", input: {} }],
      },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY }
    );

    expect(toolCallOutcomes[0].toolCall.status).toBe("denied");
    expect(toolCallOutcomes[0].approval).toBeNull();
    expect(agentRun.status).toBe("succeeded"); // nothing left pending — a denial isn't a failure of the run itself
  });
});
