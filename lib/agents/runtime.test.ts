import { describe, it, expect } from "vitest";
import { runAgent, resumeAfterApprovalDecision } from "./runtime";
import { seedAgents } from "./seed";
import { InMemoryAgentStore } from "./agentStore";
import { InMemoryAgentRunStore } from "./runStore";
import { InMemoryToolCallStore, ToolCallStore, UpdateToolCallInput } from "./toolCallStore";
import { DEFAULT_TOOL_REGISTRY, draftCustomerMessageTool, createInternalNoteTool, pingTool, AnyToolDefinition } from "./toolRegistry";
import { InMemoryApprovalStore } from "@/lib/approvals/store";
import { approveApproval, rejectApproval } from "@/lib/approvals/service";
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
    // P0.9 Slice C correction 2: draft_customer_message's persisted audit
    // summary no longer carries the raw draft text — see
    // toolRegistry.ts::draftCustomerMessageTool.summarizeOutputForAudit.
    expect(executed.responseSummary).toEqual({ hasDraft: true, draftLength: "Hi, following up on your estimate.".length });
    expect(JSON.stringify(executed.responseSummary)).not.toContain("Hi, following up");

    const finalRun = await runStore.getById(tenantId, agentRun.id);
    expect(finalRun?.status).toBe("succeeded");
    expect(finalRun?.completedAt).not.toBeNull();

    // 6. Outcome recorded against the completed run.
    const { outcome } = await recordOutcome(
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
    // P0.9 Slice B, finding H-04/B-07: before Slice B this asserted
    // 'succeeded' — an all-denied run silently reported success, exactly
    // the bug the truthful-status rework fixes. See lib/agents/runStatus.ts.
    expect(agentRun.status).toBe("denied");
  });

  it("scenario 13: a mixture of an allowed success and a policy denial reports a truthful 'partial' status", async () => {
    const tenantId = "tenant-e2e-partial";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });

    const agent = await agentStore.create({
      tenantId,
      agentType: "dev_test",
      name: "Mixed-outcome agent",
      status: "active",
      allowedTools: ["ping", "locked"],
      approvalPolicy: { ping: "AUTO_EXECUTE", locked: "HUMAN_ONLY" },
    });
    const lockedTool: AnyToolDefinition = {
      ...DEFAULT_TOOL_REGISTRY.ping,
      name: "locked",
      minimumAutonomyTier: "HUMAN_ONLY",
    };
    const tools = { ...DEFAULT_TOOL_REGISTRY, [lockedTool.name]: lockedTool };

    const { toolCallOutcomes, agentRun } = await runAgent(
      {
        tenantId,
        agentId: agent.id,
        reasoning: { prompt: "test" },
        toolPlan: [
          { toolName: "ping", action: "execute", input: {} },
          { toolName: "locked", action: "execute", input: {} },
        ],
      },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools }
    );

    expect(toolCallOutcomes[0].toolCall.status).toBe("succeeded");
    expect(toolCallOutcomes[1].toolCall.status).toBe("denied");
    expect(agentRun.status).toBe("partial");
  });

  it("scenario 15: a genuine execution failure alongside a success reports 'failed', not 'partial'", async () => {
    const tenantId = "tenant-e2e-failed";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });

    const agent = await agentStore.create({
      tenantId,
      agentType: "dev_test",
      name: "Failing-tool agent",
      status: "active",
      allowedTools: ["ping"],
      approvalPolicy: { ping: "AUTO_EXECUTE" },
    });

    const { agentRun } = await runAgent(
      {
        tenantId,
        agentId: agent.id,
        reasoning: { prompt: "test" },
        toolPlan: [
          { toolName: "ping", action: "execute", input: {} },
          { toolName: "nonexistent_tool", action: "execute", input: {} },
        ],
      },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY }
    );

    expect(agentRun.status).toBe("failed");
  });

  it("scenario 17: a tool output failing its own validateOutput contract is recorded as failed, never succeeded", async () => {
    const tenantId = "tenant-e2e-badoutput";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });

    const agent = await agentStore.create({
      tenantId,
      agentType: "dev_test",
      name: "Malformed-output agent",
      status: "active",
      allowedTools: ["ping"],
      approvalPolicy: { ping: "AUTO_EXECUTE" },
    });

    // A deliberately malformed tool: claims ok:true but its summary fails
    // the same validateOutput contract as the real pingTool (missing
    // pong: true).
    const malformedTool: AnyToolDefinition = {
      ...DEFAULT_TOOL_REGISTRY.ping,
      async execute() {
        return { ok: true, summary: { pong: "not-a-boolean" } };
      },
    };

    const { toolCallOutcomes, agentRun } = await runAgent(
      { tenantId, agentId: agent.id, reasoning: { prompt: "test" }, toolPlan: [{ toolName: "ping", action: "execute", input: {} }] },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: { ping: malformedTool } }
    );

    expect(toolCallOutcomes[0].toolCall.status).toBe("failed");
    expect(toolCallOutcomes[0].toolCall.error).toMatch(/output validation failed/);
    expect(agentRun.status).toBe("failed");
  });

  it("B-08: every created tool_call carries an immutable policy snapshot reflecting the decision actually made", async () => {
    const tenantId = "tenant-e2e-snapshot";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });

    const agent = await agentStore.create({
      tenantId,
      agentType: "dev_test",
      name: "Snapshot agent",
      status: "active",
      allowedTools: ["ping"],
      approvalPolicy: { ping: "AUTO_EXECUTE" },
      systemInstructions: "v3 instructions",
    });

    const { toolCallOutcomes } = await runAgent(
      { tenantId, agentId: agent.id, reasoning: { prompt: "test" }, toolPlan: [{ toolName: "ping", action: "execute", input: {} }] },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY }
    );

    const snapshot = toolCallOutcomes[0].toolCall.policySnapshot;
    expect(snapshot.toolName).toBe("ping");
    expect(snapshot.decision).toBe("allow");
    expect(snapshot.resolvedTier).toBe("AUTO_EXECUTE");
    expect(snapshot.intrinsicPermission).toBe("EXECUTE");
    expect(snapshot.toolDefinitionVersion).toBe(DEFAULT_TOOL_REGISTRY.ping.version);
    expect(snapshot.agentInstructionsVersion).toBe(agent.instructionsVersion);

    // The historical record must survive a later mutation of the agent's
    // CURRENT configuration — reconstructing "why" must read the snapshot,
    // never live config (scenario 16, integration-level companion to the
    // pure-function test in permissions.test.ts).
    await agentStore.update(tenantId, agent.id, { approvalPolicy: { ping: "HUMAN_ONLY" } });
    const stillOnDisk = await toolCallStore.listByAgentRun(tenantId, toolCallOutcomes[0].toolCall.agentRunId);
    expect(stillOnDisk[0].policySnapshot.decision).toBe("allow");
    expect(stillOnDisk[0].policySnapshot.resolvedTier).toBe("AUTO_EXECUTE");
  });

  it("an unregistered tool's tool_call still carries a policy snapshot (tool: null case)", async () => {
    const tenantId = "tenant-e2e-unregistered";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });
    const { devTest } = await seedAgents(tenantId, agentStore);

    const { toolCallOutcomes } = await runAgent(
      { tenantId, agentId: devTest.id, reasoning: { prompt: "test" }, toolPlan: [{ toolName: "nonexistent_tool", action: "execute", input: {} }] },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY }
    );

    const snapshot = toolCallOutcomes[0].toolCall.policySnapshot;
    expect(snapshot.decision).toBe("deny");
    expect(snapshot.intrinsicPermission).toBeNull();
    expect(snapshot.toolDefinitionVersion).toBeNull();
    expect(snapshot.reason).toMatch(/not registered/);
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

  /** Wraps a ToolCallStore and records every `update()` call's patch, so a
   * test can assert on exactly what was written (or NOT written) without
   * relying on comparing returned object references — InMemoryToolCallStore
   * mutates and returns the same shared row for every caller, so two
   * "different" returned objects can actually be the same aliased row (see
   * the comment this replaced, kept in git history). */
  function spyOnUpdates(inner: ToolCallStore): { store: ToolCallStore; updates: Array<{ id: string; patch: UpdateToolCallInput }> } {
    const updates: Array<{ id: string; patch: UpdateToolCallInput }> = [];
    const store: ToolCallStore = {
      create: (...args) => inner.create(...args),
      listByAgentRun: (...args) => inner.listByAgentRun(...args),
      getByApprovalId: (...args) => inner.getByApprovalId(...args),
      update: (tenantId, id, patch) => {
        updates.push({ id, patch });
        return inner.update(tenantId, id, patch);
      },
    };
    return { store, updates };
  }

  it("test 4: two consumers racing the same approved approval — exactly one executes, the loser never mutates tool_call to failed", async () => {
    // The real invariant — "only one legitimate execution may win" — is
    // that the tool's own side-effecting body runs once (checked directly
    // below) AND that the losing caller never writes status:'failed' to
    // the shared tool_call (checked via the update spy — this is exactly
    // the independent-review finding: losing beginExecution() used to
    // unconditionally mark the tool_call failed, capable of corrupting a
    // call the winner was legitimately still executing).
    const tenantId = "tenant-race";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const { store: toolCallStore, updates } = spyOnUpdates(new InMemoryToolCallStore());
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
    updates.length = 0; // only care about writes from the race itself, not setup

    await Promise.all([
      resumeAfterApprovalDecision(tenantId, approval.id, deps),
      resumeAfterApprovalDecision(tenantId, approval.id, deps),
    ]);

    expect(executionCount).toBe(1);

    const spuriousFailures = updates.filter((u) => u.patch.status === "failed" && String(u.patch.error ?? "").match(/execution refused/));
    expect(spuriousFailures).toHaveLength(0);

    const finalApproval = await approvalStore.getById(tenantId, approval.id);
    expect(finalApproval?.status).toBe("executed");

    const finalToolCall = await toolCallStore.getByApprovalId(tenantId, approval.id);
    expect(finalToolCall?.status).toBe("succeeded");
  });

  it("test 5: resuming an approval that's already 'executing' (another caller mid-flight) is a safe no-op", async () => {
    const { tenantId, deps, approval, toolCallStore, approvalStore } = await setupApprovedButUnresolvedCall();
    const toolCall = await toolCallStore.getByApprovalId(tenantId, approval.id);

    // Simulate "another executor already owns it": claim the CAS directly,
    // WITHOUT completing it — exactly the state a genuinely concurrent,
    // still-in-flight winner would leave it in.
    const claimed = await approvalStore.beginExecution(tenantId, approval.id, approval.payloadDigest);
    expect(claimed?.status).toBe("executing");

    const result = await resumeAfterApprovalDecision(tenantId, approval.id, deps);

    // Safe no-op: the tool_call is returned unchanged, NOT marked failed.
    expect(result.status).toBe(toolCall?.status);
    expect(result.error).toBeFalsy();

    // And the approval is still legitimately 'executing' — this caller did
    // not disturb the in-flight owner's claim.
    const approvalAfter = await approvalStore.getById(tenantId, approval.id);
    expect(approvalAfter?.status).toBe("executing");
  });

  it("test 6: resuming an approval that's already 'executed' (duplicate resume) is a safe no-op", async () => {
    const { tenantId, deps, approval } = await setupApprovedButUnresolvedCall();

    const first = await resumeAfterApprovalDecision(tenantId, approval.id, deps);
    expect(first.status).toBe("succeeded");

    const second = await resumeAfterApprovalDecision(tenantId, approval.id, deps);
    // Safe no-op: returns the already-resolved tool call unchanged, not a
    // second execution and not an error.
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("succeeded");
    expect(second.completedAt).toBe(first.completedAt);

    const approvalAfter = await deps.approvalStore.getById(tenantId, approval.id);
    expect(approvalAfter?.status).toBe("executed");
  });

  it("test 7: refuses execution on payload digest mismatch, recorded as an integrity failure — never a benign no-op (approval UI reviews A, tool must not execute B)", async () => {
    const { tenantId, deps, approval, approvalStore } = await setupApprovedButUnresolvedCall();

    // Simulate tampering: something mutates the APPROVAL's own recorded
    // payload after the human approved the original draft. P0.9 Slice C,
    // finding H-05/C.5: execution now sources its input exclusively from
    // approval.payload (never tool_calls.request_summary, which is a
    // privacy-minimized AUDIT summary that may not even be shaped like
    // valid tool input — see runtime.ts::executeApprovedToolCall) — so the
    // tampering surface this test exercises moved from request_summary to
    // approval.payload itself. There is no public store method to mutate
    // an approval's payload post-creation; mutating it directly here is
    // the point: this is the anomaly the payload digest exists to catch,
    // not a supported operation.
    const stored = await approvalStore.getById(tenantId, approval.id);
    stored!.payload = { draft: "A completely different, unapproved message" };

    const result = await resumeAfterApprovalDecision(tenantId, approval.id, deps);
    // This is the OTHER branch from test 4/5's benign no-op: a digest
    // mismatch is a genuine integrity problem, so — unlike losing a race —
    // it DOES mark the tool_call failed, with a distinct reason that never
    // reads like "another executor already owns it."
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/payload binding verification failed/);
    expect(result.error).not.toMatch(/another executor/);

    // And the approval itself was never consumed — it's still 'approved',
    // not silently marked executed.
    const approvalAfter = await deps.approvalStore.getById(tenantId, approval.id);
    expect(approvalAfter?.status).toBe("approved");
  });

  it("approval executes the exact approval.payload, not a stale or redacted copy", async () => {
    const { tenantId, deps, approval } = await setupApprovedButUnresolvedCall();
    expect(approval.payload).toEqual({ draft: "Original approved draft" });

    const executed = await resumeAfterApprovalDecision(tenantId, approval.id, deps);
    expect(executed.status).toBe("succeeded");
    // P0.9 Slice C correction 2: what's PERSISTED is the redacted audit
    // summary, never the raw draft text — but its length still proves
    // execution ran against the exact approved payload ("Original approved
    // draft", 23 chars), not a stale or substituted one.
    expect(executed.responseSummary).toEqual({ hasDraft: true, draftLength: "Original approved draft".length });
    expect(JSON.stringify(executed.responseSummary)).not.toContain("Original approved draft");
  });

  it("tool_call audit summary can be redacted without altering approval-gated execution — audit summary carries no prohibited PII", async () => {
    const tenantId = "tenant-redacted-approval";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });

    const sensitiveNote = "Customer SSN 123-45-6789, call back at +1-555-0100";
    const agent = await agentStore.create({
      tenantId,
      agentType: "dev_test",
      name: "Approval-gated note agent",
      status: "active",
      allowedTools: ["create_internal_note"],
      // Forces an otherwise-AUTO_EXECUTE_AND_LOG tool through approval —
      // agent-configured tier may be STRICTER than the tool's own floor.
      approvalPolicy: { create_internal_note: "REQUIRE_APPROVAL" },
    });
    const deps = { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY };

    const { toolCallOutcomes } = await runAgent(
      { tenantId, agentId: agent.id, reasoning: { prompt: "test" }, toolPlan: [{ toolName: "create_internal_note", action: "execute", input: { note: sensitiveNote } }] },
      deps
    );
    const approval = toolCallOutcomes[0].approval!;

    // The persisted AUDIT summary is redacted — no raw note text at all —
    // per createInternalNoteTool.summarizeInputForAudit.
    const pendingToolCall = toolCallOutcomes[0].toolCall;
    expect(JSON.stringify(pendingToolCall.requestSummary)).not.toContain("123-45-6789");
    expect(pendingToolCall.requestSummary).toEqual({ noteLength: sensitiveNote.length });
    // The canonical, unredacted execution payload lives on the approval.
    expect(approval.payload).toEqual({ note: sensitiveNote });

    await approveApproval(tenantId, approval.id, "owner-1", "owner", approvalStore);
    const executed = await resumeAfterApprovalDecision(tenantId, approval.id, deps);

    // createInternalNoteTool.validateInput requires `note` to be a
    // non-empty STRING — the redacted audit summary ({ noteLength: N })
    // would fail that check outright (note would be undefined). A
    // 'succeeded' result here is only reachable if execution actually
    // validated/ran against approval.payload's real { note: string }, not
    // the redacted requestSummary — proving execution never sourced from
    // the redacted audit summary.
    expect(executed.status).toBe("succeeded");

    // And what's PERSISTED afterward is still redacted — no raw note text.
    const finalToolCall = await toolCallStore.getByApprovalId(tenantId, approval.id);
    expect(JSON.stringify(finalToolCall!.responseSummary)).not.toContain("123-45-6789");
    expect(finalToolCall!.responseSummary).toEqual({ noteLength: sensitiveNote.length });
  });

  it("auto-execute tool receives the full in-memory input while the stored audit summary is redacted", async () => {
    const tenantId = "tenant-autoexec-redacted";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });

    const sensitiveNote = "Customer phone +1-555-0199, address 42 Main St";
    let actualExecuteInput: { note: string } | null = null;
    const spyingNoteTool: AnyToolDefinition = {
      ...createInternalNoteTool,
      async execute(input, ctx) {
        actualExecuteInput = input;
        return createInternalNoteTool.execute(input, ctx);
      },
    };
    const tools = { ...DEFAULT_TOOL_REGISTRY, [spyingNoteTool.name]: spyingNoteTool };

    const agent = await agentStore.create({
      tenantId,
      agentType: "dev_test",
      name: "Auto-execute note agent",
      status: "active",
      allowedTools: ["create_internal_note"],
      approvalPolicy: { create_internal_note: "AUTO_EXECUTE_AND_LOG" },
    });

    const { toolCallOutcomes } = await runAgent(
      { tenantId, agentId: agent.id, reasoning: { prompt: "test" }, toolPlan: [{ toolName: "create_internal_note", action: "execute", input: { note: sensitiveNote } }] },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools }
    );

    expect(toolCallOutcomes[0].toolCall.status).toBe("succeeded");
    // The tool actually ran on the FULL, unredacted note.
    expect(actualExecuteInput).toEqual({ note: sensitiveNote });
    // What's PERSISTED is redacted, on both sides.
    expect(JSON.stringify(toolCallOutcomes[0].toolCall.requestSummary)).not.toContain("555-0199");
    expect(toolCallOutcomes[0].toolCall.requestSummary).toEqual({ noteLength: sensitiveNote.length });
    expect(JSON.stringify(toolCallOutcomes[0].toolCall.responseSummary)).not.toContain("555-0199");
    expect(toolCallOutcomes[0].toolCall.responseSummary).toEqual({ noteLength: sensitiveNote.length });
  });

  it("output audit summarization never alters the actual succeeded/failed decision or validateOutput enforcement", async () => {
    // A tool whose summarizeOutputForAudit would (if wrongly consulted by
    // the succeeded/failed decision or validateOutput) make a truthful
    // failure look like a redacted success, or vice versa — proves those
    // two decisions evaluate the RAW result.summary, never the audit
    // summary.
    const tenantId = "tenant-output-audit";
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });

    const misleadingAuditTool: AnyToolDefinition = {
      ...pingTool,
      summarizeOutputForAudit() {
        // Deliberately misleading — if this ever influenced validateOutput
        // or the ok/fail decision, the malformed-output test below would
        // pass when it must not.
        return { pong: true, redacted: true };
      },
      async execute() {
        return { ok: true, summary: { pong: "not-a-boolean" } }; // malformed per pingTool.validateOutput
      },
    };

    const agent = await agentStore.create({
      tenantId,
      agentType: "dev_test",
      name: "Misleading-audit agent",
      status: "active",
      allowedTools: ["ping"],
      approvalPolicy: { ping: "AUTO_EXECUTE" },
    });

    const { toolCallOutcomes } = await runAgent(
      { tenantId, agentId: agent.id, reasoning: { prompt: "test" }, toolPlan: [{ toolName: "ping", action: "execute", input: {} }] },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: { ping: misleadingAuditTool } }
    );

    // validateOutput still correctly rejects the malformed raw result,
    // regardless of what summarizeOutputForAudit would have reported.
    expect(toolCallOutcomes[0].toolCall.status).toBe("failed");
    expect(toolCallOutcomes[0].toolCall.error).toMatch(/output validation failed/);
    // The persisted summary is still the (misleading, by design of this
    // test) audit summary — proving summarization applies to WHAT'S
    // PERSISTED only, never to the pass/fail decision itself.
    expect(toolCallOutcomes[0].toolCall.responseSummary).toEqual({ pong: true, redacted: true });
  });

  it("scenario 14: rejecting the approval denies the tool call without ever executing it, and the run reports a truthful terminal status", async () => {
    // Deliberately its own setup, NOT setupApprovedButUnresolvedCall(): a
    // rejection is only ever legal from 'pending' (decide() is a CAS
    // WHERE status = 'pending' — see Issue 1's fix), so this test rejects
    // the approval while it's genuinely still pending rather than forcing
    // an already-approved approval into 'rejected', which the fixed CAS
    // now correctly refuses to allow.
    const tenantId = "tenant-reject-flow";
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

    await rejectApproval(tenantId, approval.id, "owner-1", "owner", "not needed", approvalStore);

    const result = await resumeAfterApprovalDecision(tenantId, approval.id, deps);
    expect(result.status).toBe("denied");
    expect(result.error).toMatch(/rejected/);

    const toolCall = await toolCallStore.getByApprovalId(tenantId, approval.id);
    expect(toolCall?.status).toBe("denied");

    // P0.9 Slice B, finding H-04/B-07: a rejected approval must never
    // silently resolve the run to 'succeeded'.
    const finalRun = await runStore.getById(tenantId, toolCallOutcomes[0].toolCall.agentRunId);
    expect(finalRun?.status).toBe("denied");
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

/**
 * P0.9 Slice C correction 2/2B/3 — tool audit privacy fail-closed and the
 * agent_run model-output fingerprint. Explicit sentinel values, per the
 * correction's own validation requirement: these exact strings must NEVER
 * appear in any persisted tool_calls.request_summary,
 * tool_calls.response_summary, or agent_runs.output_summary.
 */
describe("P0.9 Slice C correction 2/2B/3 — audit privacy fail-closed, sentinel-value assertions", () => {
  const SENTINEL_PHONE = "+15550001111";
  const SENTINEL_EMAIL = "private@example.test";
  const SENTINEL_MESSAGE = "SUPER-SECRET-MESSAGE";

  function assertNoSentinels(value: unknown) {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain(SENTINEL_PHONE);
    expect(serialized).not.toContain(SENTINEL_EMAIL);
    expect(serialized).not.toContain(SENTINEL_MESSAGE);
  }

  async function freshDeps() {
    const tenantId = `tenant-privacy-${Math.random().toString(36).slice(2)}`;
    const agentStore = new InMemoryAgentStore();
    const runStore = new InMemoryAgentRunStore();
    const toolCallStore = new InMemoryToolCallStore();
    const approvalStore = new InMemoryApprovalStore();
    const gateway = new AiGateway({ chatProviders: { mock: new MockChatProvider() }, invocationStore: new InMemoryModelInvocationStore() });
    const { devTest } = await seedAgents(tenantId, agentStore);
    return { tenantId, agentStore, runStore, toolCallStore, approvalStore, gateway, devTest };
  }

  it("correction 2B: malformed create_internal_note input never crashes the run — recorded failed for invalid input", async () => {
    const { tenantId, agentStore, runStore, toolCallStore, approvalStore, gateway, devTest } = await freshDeps();

    // Malformed per createInternalNoteTool.validateInput (note must be a
    // non-empty string) AND a shape that would have thrown inside the OLD
    // summarizeInputForAudit (`input.note.length` on a non-string note),
    // before it was retyped to accept `unknown` and made total.
    const { toolCallOutcomes, agentRun } = await runAgent(
      { tenantId, agentId: devTest.id, reasoning: { prompt: "test" }, toolPlan: [{ toolName: "create_internal_note", action: "execute", input: { note: 12345 } }] },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY }
    );

    expect(toolCallOutcomes[0].toolCall.status).toBe("failed");
    expect(toolCallOutcomes[0].toolCall.error).toMatch(/invalid input/);
    expect(agentRun.status).toBe("failed");
    // The audit summary computed BEFORE validation must still be safe —
    // conservativeAuditFallback, since the raw { note: 12345 } shape isn't
    // what the tool's own summarizer expects.
    expect(toolCallOutcomes[0].toolCall.requestSummary).toEqual({ redacted: true, keys: ["note"], fieldCount: 1 });
  });

  it("correction 2B: a tool summarizer that throws never crashes the run — falls back to the conservative structural summary", async () => {
    const { tenantId, agentStore, runStore, toolCallStore, approvalStore, gateway, devTest } = await freshDeps();

    const throwingTool: AnyToolDefinition = {
      ...pingTool,
      summarizeInputForAudit() {
        throw new Error("summarizer exploded");
      },
      summarizeOutputForAudit() {
        throw new Error("summarizer exploded");
      },
    };

    const { toolCallOutcomes } = await runAgent(
      { tenantId, agentId: devTest.id, reasoning: { prompt: "test" }, toolPlan: [{ toolName: "ping", action: "execute", input: { secret: SENTINEL_MESSAGE } }] },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: { ping: throwingTool } }
    );

    expect(toolCallOutcomes[0].toolCall.status).toBe("succeeded");
    expect(toolCallOutcomes[0].toolCall.requestSummary).toEqual({ redacted: true, keys: ["secret"], fieldCount: 1 });
    assertNoSentinels(toolCallOutcomes[0].toolCall.requestSummary);
    assertNoSentinels(toolCallOutcomes[0].toolCall.responseSummary);
  });

  it("correction 2: draft_customer_message's request_summary and response_summary contain no message text", async () => {
    const { tenantId, agentStore, runStore, toolCallStore, approvalStore, gateway, devTest } = await freshDeps();

    const { toolCallOutcomes } = await runAgent(
      {
        tenantId,
        agentId: devTest.id,
        reasoning: { prompt: "test" },
        toolPlan: [{ toolName: "draft_customer_message", action: "execute", input: { draft: SENTINEL_MESSAGE } }],
      },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY }
    );
    const pending = toolCallOutcomes[0].toolCall;
    assertNoSentinels(pending.requestSummary);
    expect(pending.requestSummary).toEqual({ hasDraft: true, draftLength: SENTINEL_MESSAGE.length });

    const approval = toolCallOutcomes[0].approval!;
    await approveApproval(tenantId, approval.id, "owner-1", "owner", approvalStore);
    const executed = await resumeAfterApprovalDecision(tenantId, approval.id, {
      agentStore,
      runStore,
      toolCallStore,
      approvalStore,
      gateway,
      tools: DEFAULT_TOOL_REGISTRY,
    });
    expect(executed.status).toBe("succeeded");
    assertNoSentinels(executed.responseSummary);
    expect(executed.responseSummary).toEqual({ hasDraft: true, draftLength: SENTINEL_MESSAGE.length });
  });

  it("correction 2: ping with sentinel phone/email/message input -> persisted summaries contain none of those values", async () => {
    const { tenantId, agentStore, runStore, toolCallStore, approvalStore, gateway, devTest } = await freshDeps();

    const { toolCallOutcomes } = await runAgent(
      {
        tenantId,
        agentId: devTest.id,
        reasoning: { prompt: "test" },
        toolPlan: [{ toolName: "ping", action: "execute", input: { phone: SENTINEL_PHONE, email: SENTINEL_EMAIL, message: SENTINEL_MESSAGE } }],
      },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY }
    );

    expect(toolCallOutcomes[0].toolCall.status).toBe("succeeded");
    assertNoSentinels(toolCallOutcomes[0].toolCall.requestSummary);
    assertNoSentinels(toolCallOutcomes[0].toolCall.responseSummary);
    // ping's own execute() echoes its input into result.summary.input — the
    // RAW result is fine to carry it in-memory, but the PERSISTED audit
    // summary must be the conservative fallback (ping defines no
    // summarizer by design).
    expect(toolCallOutcomes[0].toolCall.requestSummary).toEqual({ redacted: true, keys: ["phone", "email", "message"], fieldCount: 3 });
  });

  it("correction 2: an unregistered tool with an arbitrary sentinel payload -> persisted audit contains no raw values", async () => {
    const { tenantId, agentStore, runStore, toolCallStore, approvalStore, gateway, devTest } = await freshDeps();

    const { toolCallOutcomes } = await runAgent(
      {
        tenantId,
        agentId: devTest.id,
        reasoning: { prompt: "test" },
        toolPlan: [{ toolName: "nonexistent_tool", action: "execute", input: { phone: SENTINEL_PHONE, email: SENTINEL_EMAIL, note: SENTINEL_MESSAGE } }],
      },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY }
    );

    expect(toolCallOutcomes[0].toolCall.status).toBe("failed");
    assertNoSentinels(toolCallOutcomes[0].toolCall.requestSummary);
    expect(toolCallOutcomes[0].toolCall.requestSummary).toEqual({ redacted: true, keys: ["phone", "email", "note"], fieldCount: 3 });
  });

  it("correction 3: agent_runs.output_summary is a fingerprint, never the raw model response text, even when the response echoes sentinel PII", async () => {
    const { tenantId, agentStore, runStore, toolCallStore, approvalStore, gateway, devTest } = await freshDeps();

    // MockChatProvider echoes the prompt (truncated to 200 chars) back into
    // its response text — an easy, deterministic way to prove sentinel
    // values that make it into the model's OWN response text never survive
    // into the persisted agent_runs.output_summary.
    const prompt = `Contact info: ${SENTINEL_PHONE} ${SENTINEL_EMAIL} ${SENTINEL_MESSAGE}`;
    const { agentRun } = await runAgent(
      { tenantId, agentId: devTest.id, reasoning: { prompt }, toolPlan: [] },
      { agentStore, runStore, toolCallStore, approvalStore, gateway, tools: DEFAULT_TOOL_REGISTRY }
    );

    expect(agentRun.outputSummary).not.toBeNull();
    assertNoSentinels(agentRun.outputSummary);
    // Fingerprint shape: sha256:<hex digest>;chars:<length> — never raw text.
    expect(agentRun.outputSummary).toMatch(/^sha256:[0-9a-f]{64};chars:\d+$/);
    // provider/model/task metadata is unaffected by the fingerprint switch.
    expect(agentRun.modelStrategy).toMatchObject({ provider: "mock", taskType: "reason" });
  });

  it("correction 3: the fingerprint is deterministic for identical text and different for different text", async () => {
    const depsA = await freshDeps();
    const depsB = await freshDeps();

    const samePrompt = "identical prompt text for both runs";
    const { agentRun: runA } = await runAgent(
      { tenantId: depsA.tenantId, agentId: depsA.devTest.id, reasoning: { prompt: samePrompt }, toolPlan: [] },
      { agentStore: depsA.agentStore, runStore: depsA.runStore, toolCallStore: depsA.toolCallStore, approvalStore: depsA.approvalStore, gateway: depsA.gateway, tools: DEFAULT_TOOL_REGISTRY }
    );
    const { agentRun: runB } = await runAgent(
      { tenantId: depsB.tenantId, agentId: depsB.devTest.id, reasoning: { prompt: samePrompt }, toolPlan: [] },
      { agentStore: depsB.agentStore, runStore: depsB.runStore, toolCallStore: depsB.toolCallStore, approvalStore: depsB.approvalStore, gateway: depsB.gateway, tools: DEFAULT_TOOL_REGISTRY }
    );
    // Same model/prompt -> MockChatProvider produces identical response
    // text -> identical fingerprint.
    expect(runA.outputSummary).toBe(runB.outputSummary);

    const { agentRun: runC } = await runAgent(
      { tenantId: depsA.tenantId, agentId: depsA.devTest.id, reasoning: { prompt: "a completely different prompt" }, toolPlan: [] },
      { agentStore: depsA.agentStore, runStore: depsA.runStore, toolCallStore: depsA.toolCallStore, approvalStore: depsA.approvalStore, gateway: depsA.gateway, tools: DEFAULT_TOOL_REGISTRY }
    );
    expect(runC.outputSummary).not.toBe(runA.outputSummary);
  });
});
