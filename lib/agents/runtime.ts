import { Agent } from "./types";
import { AgentStore, SupabaseAgentStore } from "./agentStore";
import { AgentRun, AgentRunStore, SupabaseAgentRunStore } from "./runStore";
import { ToolCall, ToolCallStore, SupabaseToolCallStore } from "./toolCallStore";
import { evaluateToolCall } from "./permissions";
import { DEFAULT_TOOL_REGISTRY, AnyToolDefinition } from "./toolRegistry";
import { AiGateway, ai as defaultGateway } from "@/lib/ai/gateway";
import { ApprovalStore, SupabaseApprovalStore } from "@/lib/approvals/store";
import { Approval } from "@/lib/approvals/types";
import { computePayloadDigest } from "@/lib/approvals/payloadBinding";

/**
 * The minimal agent runtime (P0.3, hardened P0.9 Slice A): executes ONE
 * agent against a caller-supplied plan of tool calls, enforcing policy
 * (P0.4) before every tool call and recording the full observability chain
 * (P0.7) — agent_run, model_invocations (via the gateway), tool_calls,
 * approvals.
 *
 * SECURITY INVARIANT (Codex P0 audit finding B-02): PlannedToolCall carries
 * only {toolName, action, input} — there is no permission field anywhere a
 * caller can set. Authorization is derived entirely from the REGISTERED
 * ToolDefinition (see lib/agents/toolRegistry.ts and
 * lib/agents/permissions.ts::evaluateToolCall); an unregistered tool name
 * is refused before any authorization decision is even attempted.
 *
 * Deliberately NOT an autonomous tool-use loop: the model is asked to
 * reason once per run (proving "Model Gateway invoked" in the P0 exit
 * criteria) and its output is recorded as context, but which tools actually
 * run is a plan the caller declares up front. Parsing tool selection out of
 * the model's own free-text response is real intelligence — that's P1
 * (Estimate Closing Agent etc.), once agents have a reason to need it. This
 * keeps P0 honest: it proves the plumbing works, it does not fake
 * autonomy. See docs/AGENTIC_ROADMAP.md.
 */

export type PlannedToolCall = {
  toolName: string;
  action: string;
  input: Record<string, unknown>;
};

export type RunAgentInput = {
  tenantId: string;
  agentId: string;
  triggerEventId?: string | null;
  workflowId?: string | null;
  reasoning: { prompt: string; system?: string };
  toolPlan: PlannedToolCall[];
};

export type ToolCallOutcome = {
  toolCall: ToolCall;
  approval: Approval | null;
};

export type RunAgentResult = {
  agent: Agent;
  agentRun: AgentRun;
  toolCallOutcomes: ToolCallOutcome[];
};

export type AgentRuntimeDeps = {
  agentStore?: AgentStore;
  runStore?: AgentRunStore;
  toolCallStore?: ToolCallStore;
  approvalStore?: ApprovalStore;
  gateway?: AiGateway;
  tools?: Record<string, AnyToolDefinition>;
};

function resolveDeps(deps: AgentRuntimeDeps) {
  return {
    agentStore: deps.agentStore ?? new SupabaseAgentStore(),
    runStore: deps.runStore ?? new SupabaseAgentRunStore(),
    toolCallStore: deps.toolCallStore ?? new SupabaseToolCallStore(),
    approvalStore: deps.approvalStore ?? new SupabaseApprovalStore(),
    gateway: deps.gateway ?? defaultGateway,
    tools: deps.tools ?? DEFAULT_TOOL_REGISTRY,
  };
}

function riskLevelFor(tool: AnyToolDefinition): "high" | "medium" {
  return tool.intrinsicPermission === "FINANCIAL_ACTION" || tool.intrinsicPermission === "DELETE" ? "high" : "medium";
}

export async function runAgent(input: RunAgentInput, deps: AgentRuntimeDeps = {}): Promise<RunAgentResult> {
  const { agentStore, runStore, toolCallStore, approvalStore, gateway, tools } = resolveDeps(deps);

  const agent = await agentStore.getById(input.tenantId, input.agentId);
  if (!agent) throw new Error(`agent ${input.agentId} not found for tenant ${input.tenantId}`);

  let agentRun = await runStore.create({
    tenantId: input.tenantId,
    agentId: agent.id,
    triggerEventId: input.triggerEventId ?? null,
    workflowId: input.workflowId ?? null,
  });
  agentRun = await runStore.update(input.tenantId, agentRun.id, { status: "running", startedAt: new Date().toISOString() });

  // 1. Model Gateway invoked.
  try {
    const response = await gateway.reason({
      tenantId: input.tenantId,
      agentRunId: agentRun.id,
      workflowId: input.workflowId ?? undefined,
      prompt: input.reasoning.prompt,
      system: input.reasoning.system ?? agent.systemInstructions ?? undefined,
    });
    agentRun = await runStore.update(input.tenantId, agentRun.id, {
      modelStrategy: { provider: response.provider, model: response.model, taskType: "reason" },
      outputSummary: response.text.slice(0, 2000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    agentRun = await runStore.update(input.tenantId, agentRun.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      failureReason: `model gateway failed: ${message}`,
    });
    return { agent, agentRun, toolCallOutcomes: [] };
  }

  // 2. Agent policy evaluated (from the REGISTERED tool, never caller
  //    input) + mock/safe tool called, per planned call.
  const outcomes: ToolCallOutcome[] = [];
  let anyAwaitingApproval = false;
  let anyFailed = false;

  for (const planned of input.toolPlan) {
    const tool = tools[planned.toolName];

    if (!tool) {
      const toolCall = await toolCallStore.create({
        tenantId: input.tenantId,
        agentRunId: agentRun.id,
        toolName: planned.toolName,
        action: planned.action,
        requestSummary: planned.input,
        requiresApproval: false,
      });
      const updated = await toolCallStore.update(input.tenantId, toolCall.id, {
        status: "failed",
        error: `tool '${planned.toolName}' is not registered`,
        completedAt: new Date().toISOString(),
      });
      outcomes.push({ toolCall: updated, approval: null });
      anyFailed = true;
      continue;
    }

    const decision = evaluateToolCall(agent, tool);

    const toolCall = await toolCallStore.create({
      tenantId: input.tenantId,
      agentRunId: agentRun.id,
      toolName: tool.name,
      action: planned.action,
      requestSummary: planned.input,
      requiresApproval: decision.decision === "require_approval",
    });

    if (decision.decision === "deny") {
      const updated = await toolCallStore.update(input.tenantId, toolCall.id, {
        status: "denied",
        error: decision.reason,
        completedAt: new Date().toISOString(),
      });
      outcomes.push({ toolCall: updated, approval: null });
      continue;
    }

    // Input is validated by the tool's OWN validator before either
    // executing or bothering a human with an approval request — a
    // malformed request fails fast, it never reaches the approval queue.
    const validation = tool.validateInput(planned.input);
    if (!validation.ok) {
      const updated = await toolCallStore.update(input.tenantId, toolCall.id, {
        status: "failed",
        error: `invalid input: ${validation.errors.join("; ")}`,
        completedAt: new Date().toISOString(),
      });
      outcomes.push({ toolCall: updated, approval: null });
      anyFailed = true;
      continue;
    }

    if (decision.decision === "require_approval") {
      const payloadDigest = computePayloadDigest({
        tenantId: input.tenantId,
        agentId: agent.id,
        agentRunId: agentRun.id,
        toolName: tool.name,
        action: planned.action,
        payload: planned.input,
      });
      const approval = await approvalStore.create({
        tenantId: input.tenantId,
        agentId: agent.id,
        agentRunId: agentRun.id,
        requestedAction: `${tool.name}.${planned.action}`,
        payload: planned.input,
        riskLevel: riskLevelFor(tool),
        requestedByType: "agent",
        requestedById: agent.id,
        payloadDigest,
      });
      const updated = await toolCallStore.update(input.tenantId, toolCall.id, {
        status: "requires_approval",
        approvalId: approval.id,
      });
      outcomes.push({ toolCall: updated, approval });
      anyAwaitingApproval = true;
      continue;
    }

    // decision.decision === "allow"
    const outcome = await executeToolDefinition(tool, validation.value, toolCall, input.tenantId, agentRun.id, toolCallStore);
    outcomes.push({ toolCall: outcome, approval: null });
    if (outcome.status === "failed") anyFailed = true;
  }

  const finalStatus = anyAwaitingApproval ? "awaiting_approval" : anyFailed ? "failed" : "succeeded";
  agentRun = await runStore.update(input.tenantId, agentRun.id, {
    status: finalStatus,
    completedAt: finalStatus === "awaiting_approval" ? null : new Date().toISOString(),
  });

  return { agent, agentRun, toolCallOutcomes: outcomes };
}

async function executeToolDefinition(
  tool: AnyToolDefinition,
  input: unknown,
  toolCall: ToolCall,
  tenantId: string,
  agentRunId: string,
  toolCallStore: ToolCallStore
): Promise<ToolCall> {
  try {
    const result = await tool.execute(input, { tenantId, agentRunId });
    return toolCallStore.update(tenantId, toolCall.id, {
      status: result.ok ? "succeeded" : "failed",
      responseSummary: result.summary,
      error: result.error ?? null,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolCallStore.update(tenantId, toolCall.id, {
      status: "failed",
      error: message,
      completedAt: new Date().toISOString(),
    });
  }
}

/**
 * Resume a run after a human has decided a pending approval.
 *
 * Approved path (Codex P0 audit finding B-03): recomputes the payload
 * digest from the approval's OWN stored tenant/agent/run identity plus the
 * CURRENT tool_calls row, then attempts the atomic
 * approved -> executing compare-and-swap (approvalStore.beginExecution).
 * If that fails for ANY reason — lost a race to a concurrent resume call,
 * the approval is no longer 'approved', or the digest no longer matches
 * because tool_calls.request_summary was mutated after approval — execution
 * is refused and the tool is never invoked. A diagnostic (non-authoritative)
 * read is used only to build a clearer error message.
 *
 * Rejected/expired: marks the tool call denied, but only if it hasn't
 * already reached a terminal state — a duplicate resume call on an
 * already-denied/executed tool call is a safe no-op, not a re-mutation.
 *
 * Any other current approval status (pending, executing, already executed):
 * safe no-op — returns the tool call's current state unchanged. This is
 * what makes a duplicate resume call harmless: the second call in a race,
 * or a caller resuming twice by mistake, never re-executes anything and
 * never overwrites a result that's already there.
 */
export async function resumeAfterApprovalDecision(tenantId: string, approvalId: string, deps: AgentRuntimeDeps = {}): Promise<ToolCall> {
  const { toolCallStore, approvalStore, runStore, tools } = resolveDeps(deps);

  const approval = await approvalStore.getById(tenantId, approvalId);
  if (!approval) throw new Error(`approval ${approvalId} not found for tenant ${tenantId}`);
  if (!approval.agentRunId) throw new Error(`approval ${approvalId} has no associated agent run`);

  const toolCall = await toolCallStore.getByApprovalId(tenantId, approvalId);
  if (!toolCall) throw new Error(`no tool_call found for approval ${approvalId}`);

  let updatedToolCall: ToolCall;

  if (approval.status === "approved") {
    updatedToolCall = await executeApprovedToolCall(tenantId, approval, toolCall, toolCallStore, approvalStore, tools);
  } else if (approval.status === "rejected" || approval.status === "expired") {
    const alreadyTerminal = toolCall.status !== "requires_approval" && toolCall.status !== "pending";
    updatedToolCall = alreadyTerminal
      ? toolCall
      : await toolCallStore.update(tenantId, toolCall.id, {
          status: "denied",
          error: `approval ${approval.status}`,
          completedAt: new Date().toISOString(),
        });
  } else {
    // 'pending' (decision not made yet), 'executing' (another caller is
    // mid-flight), or 'executed' (already consumed) — nothing safe to do.
    updatedToolCall = toolCall;
  }

  const remaining = await toolCallStore.listByAgentRun(tenantId, approval.agentRunId);
  const stillWaiting = remaining.some((tc) => tc.status === "requires_approval" || tc.status === "pending");
  if (!stillWaiting) {
    const anyFailed = remaining.some((tc) => tc.status === "failed");
    await runStore.update(tenantId, approval.agentRunId, {
      status: anyFailed ? "failed" : "succeeded",
      completedAt: new Date().toISOString(),
    });
  }

  return updatedToolCall;
}

async function executeApprovedToolCall(
  tenantId: string,
  approval: Approval,
  toolCall: ToolCall,
  toolCallStore: ToolCallStore,
  approvalStore: ApprovalStore,
  tools: Record<string, AnyToolDefinition>
): Promise<ToolCall> {
  const tool = tools[toolCall.toolName];
  if (!tool) {
    return toolCallStore.update(tenantId, toolCall.id, {
      status: "failed",
      error: `tool '${toolCall.toolName}' is not registered`,
      completedAt: new Date().toISOString(),
    });
  }

  const expectedDigest = computePayloadDigest({
    tenantId: approval.tenantId,
    agentId: approval.agentId,
    agentRunId: approval.agentRunId,
    toolName: toolCall.toolName,
    action: toolCall.action,
    payload: toolCall.requestSummary,
  });

  const claimed = await approvalStore.beginExecution(tenantId, approval.id, expectedDigest);
  if (!claimed) {
    const reason = await diagnoseExecutionRefusal(tenantId, approval.id, expectedDigest, approvalStore);
    return toolCallStore.update(tenantId, toolCall.id, {
      status: "failed",
      error: `execution refused: ${reason}`,
      completedAt: new Date().toISOString(),
    });
  }

  const validation = tool.validateInput(toolCall.requestSummary);
  if (!validation.ok) {
    const updated = await toolCallStore.update(tenantId, toolCall.id, {
      status: "failed",
      error: `invalid input at execution time: ${validation.errors.join("; ")}`,
      completedAt: new Date().toISOString(),
    });
    await approvalStore.completeExecution(tenantId, approval.id, { ok: false, error: updated.error });
    return updated;
  }

  const updated = await executeToolDefinition(tool, validation.value, toolCall, tenantId, approval.agentRunId as string, toolCallStore);
  await approvalStore.completeExecution(
    tenantId,
    approval.id,
    updated.status === "succeeded" ? { ok: true, summary: updated.responseSummary } : { ok: false, error: updated.error }
  );
  return updated;
}

/** Diagnostic-only read to build a clearer error message after a failed
 * beginExecution claim. Never used to decide whether to proceed — that
 * decision was already made atomically by the compare-and-swap itself. */
async function diagnoseExecutionRefusal(
  tenantId: string,
  approvalId: string,
  expectedDigest: string,
  approvalStore: ApprovalStore
): Promise<string> {
  const current = await approvalStore.getById(tenantId, approvalId);
  if (!current) return "approval no longer exists";
  if (current.status !== "approved") return `approval is '${current.status}' (single-use — already claimed, executed, or not yet approved)`;
  if (current.payloadDigest !== expectedDigest) {
    return "payload binding verification failed — the tool call's recorded input no longer matches what was approved";
  }
  return "lost a concurrent claim to execute this approval";
}
