import { describe, it, expect } from "vitest";
import { runAgent, resumeAfterApprovalDecision } from "./runtime";
import { seedAgents } from "./seed";
import { InMemoryAgentStore } from "./agentStore";
import { InMemoryAgentRunStore } from "./runStore";
import { InMemoryToolCallStore } from "./toolCallStore";
import { DEFAULT_TOOL_REGISTRY, draftCustomerMessageTool, AnyToolDefinition } from "./toolRegistry";
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

describe("resumeAfterApprovalDecision — approval safety (Codex P0 audit finding B-03)", () => {
  async function setupApprovedButUnresolvedCall() {
    const tenantId = "tenant-approval-safety";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });
    const deps = { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY };

    const { devTest } = await seedAgents(tenantId, agentStore);
    const { agentRun, toolCallOutcomes } = await runAgent(
      {
        tenantId,
        agentId: devTest.id,
        reasoning: { prompt: "test" },
        toolPlan: [{ toolName: "draft_customer_message", action: "execute", input: { draft: "Original approved draft" } }],
      },
      deps
    );
    const approval = toolCallOutcomes[0].approval!;
    await approveApproval(tenantId, approval.id, "owner-1", "owner", approvalStore);

    return { tenantId, deps, agentRun, approval, toolCallStore, approvalStore };
  }

  it("two consumers racing the same approved approval — the tool body runs exactly once", async () => {
    // Deliberately does NOT compare the two calls' RETURN VALUES against
    // each other: InMemoryToolCallStore.update mutates and returns the
    // same shared row object for every caller, so whichever write lands
    // temporally last determines what BOTH callers' references read —
    // comparing them would test the in-memory double's aliasing, not the
    // approval CAS. The real invariant — "only one legitimate execution
    // may win" — is that the tool's own side-effecting body runs once,
    // which this counts directly. lib/approvals/execution.test.ts already
    // proves the store-level CAS returns non-null exactly once; this test
    // proves that guarantee actually prevents a second real execution when
    // driven through the full runtime.
    const tenantId = "tenant-race";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });

    let executionCount = 0;
    const countingDraftTool: AnyToolDefinition = {
      ...draftCustomerMessageTool,
      async execute(input, ctx) {
        executionCount += 1;
        return draftCustomerMessageTool.execute(input, ctx);
      },
    };
    const tools = { ...DEFAULT_TOOL_REGISTRY, [countingDraftTool.name]: countingDraftTool };
    const deps = { agentStore, runStore, toolCallStore, approvalStore, gateway, tools };

    const { devTest } = await seedAgents(tenantId, agentStore);
    const { toolCallOutcomes } = await runAgent(
      { tenantId, agentId: devTest.id, reasoning: { prompt: "test" }, toolPlan: [{ toolName: "draft_customer_message", action: "execute", input: { draft: "Race me" } }] },
      deps
    );
    const approval = toolCallOutcomes[0].approval!;
    await approveApproval(tenantId, approval.id, "owner-1", "owner", approvalStore);

    await Promise.all([
      resumeAfterApprovalDecision(tenantId, approval.id, deps),
      resumeAfterApprovalDecision(tenantId, approval.id, deps),
    ]);

    expect(executionCount).toBe(1);
    const finalApproval = await approvalStore.getById(tenantId, approval.id);
    expect(finalApproval?.status).toBe("executed");
  });

  it("duplicate resume after a successful execution is a safe no-op — never re-executes", async () => {
    const { tenantId, deps, approval } = await setupApprovedButUnresolvedCall();

    const first = await resumeAfterApprovalDecision(tenantId, approval.id, deps);
    expect(first.status).toBe("succeeded");

    const second = await resumeAfterApprovalDecision(tenantId, approval.id, deps);
    // Safe no-op: returns the already-resolved tool call unchanged, not a
    // second execution and not an error.
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("succeeded");
    expect(second.completedAt).toBe(first.completedAt);
  });

  it("refuses execution when the approved payload was mutated after approval (approval UI reviews A, tool must not execute B)", async () => {
    const { tenantId, deps, approval, toolCallStore } = await setupApprovedButUnresolvedCall();

    // Simulate tampering: something mutates the tool_call's recorded input
    // after the human approved the original draft. request_summary is
    // deliberately not part of the public UpdateToolCallInput surface (see
    // toolCallStore.ts) — mutating it directly here is the point: this is
    // the anomaly the payload digest exists to catch, not a supported
    // operation.
    const toolCall = await toolCallStore.getByApprovalId(tenantId, approval.id);
    toolCall!.requestSummary = { draft: "A completely different, unapproved message" };

    const result = await resumeAfterApprovalDecision(tenantId, approval.id, deps);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/payload binding verification failed/);

    // And the approval itself was never consumed — it's still 'approved',
    // not silently marked executed.
    const approvalAfter = await deps.approvalStore.getById(tenantId, approval.id);
    expect(approvalAfter?.status).toBe("approved");
  });

  it("rejecting the approval denies the tool call without ever executing it", async () => {
    const { tenantId, deps, approval, toolCallStore } = await setupApprovedButUnresolvedCall();
    // Override the 'approved' decision by rejecting instead (simulating a
    // reject flow — approve() already ran in setup, so directly exercise
    // the reject branch of resumeAfterApprovalDecision by forcing status).
    await deps.approvalStore.decide(tenantId, approval.id, { status: "rejected" });

    const result = await resumeAfterApprovalDecision(tenantId, approval.id, deps);
    expect(result.status).toBe("denied");
    expect(result.error).toMatch(/rejected/);

    const toolCall = await toolCallStore.getByApprovalId(tenantId, approval.id);
    expect(toolCall?.status).toBe("denied");
  });

  it("resuming a still-pending approval is a safe no-op (decision not made yet)", async () => {
    const tenantId = "tenant-approval-safety-pending";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });
    const deps = { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY };

    const { devTest } = await seedAgents(tenantId, agentStore);
    const { toolCallOutcomes } = await runAgent(
      { tenantId, agentId: devTest.id, reasoning: { prompt: "test" }, toolPlan: [{ toolName: "draft_customer_message", action: "execute", input: { draft: "x" } }] },
      deps
    );
    const approval = toolCallOutcomes[0].approval!;
    expect(approval.status).toBe("pending");

    const result = await resumeAfterApprovalDecision(tenantId, approval.id, deps);
    expect(result.status).toBe("requires_approval"); // unchanged — still waiting on a real decision
  });
});
