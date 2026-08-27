import { Agent } from "./types";
import { AgentStore, SupabaseAgentStore } from "./agentStore";
import { AgentRun, AgentRunStore, SupabaseAgentRunStore } from "./runStore";
import { ToolCall, ToolCallStore, SupabaseToolCallStore } from "./toolCallStore";
import { evaluateToolCall, ToolCallRequest } from "./permissions";
import { DEFAULT_TOOL_REGISTRY, Tool } from "./toolRegistry";
import { AiGateway, ai as defaultGateway } from "@/lib/ai/gateway";
import { ApprovalStore, SupabaseApprovalStore } from "@/lib/approvals/store";
import { Approval } from "@/lib/approvals/types";

/**
 * The minimal agent runtime (P0.3): executes ONE agent against a caller-
 * supplied plan of tool calls, enforcing policy (P0.4) before every tool
 * call and recording the full observability chain (P0.7) — agent_run,
 * model_invocations (via the gateway), tool_calls, approvals.
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

export type PlannedToolCall = ToolCallRequest & {
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
  tools?: Record<string, Tool>;
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

  // 2. Agent policy evaluated + mock/safe tool called, per planned call.
  const outcomes: ToolCallOutcome[] = [];
  let anyAwaitingApproval = false;
  let anyFailed = false;

  for (const planned of input.toolPlan) {
    const decision = evaluateToolCall(agent, planned);

    const toolCall = await toolCallStore.create({
      tenantId: input.tenantId,
      agentRunId: agentRun.id,
      toolName: planned.toolName,
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

    if (decision.decision === "require_approval") {
      const approval = await approvalStore.create({
        tenantId: input.tenantId,
        agentId: agent.id,
        agentRunId: agentRun.id,
        requestedAction: `${planned.toolName}.${planned.action}`,
        payload: planned.input,
        riskLevel: planned.permission === "FINANCIAL_ACTION" || planned.permission === "DELETE" ? "high" : "medium",
        requestedByType: "agent",
        requestedById: agent.id,
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
    const outcome = await executeToolCall(tools, planned, toolCall, input.tenantId, agentRun.id, toolCallStore);
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

async function executeToolCall(
  tools: Record<string, Tool>,
  planned: PlannedToolCall,
  toolCall: ToolCall,
  tenantId: string,
  agentRunId: string,
  toolCallStore: ToolCallStore
): Promise<ToolCall> {
  const tool = tools[planned.toolName];
  if (!tool) {
    return toolCallStore.update(tenantId, toolCall.id, {
      status: "failed",
      error: `tool '${planned.toolName}' is not registered`,
      completedAt: new Date().toISOString(),
    });
  }
  try {
    const result = await tool.execute(planned.input, { tenantId, agentRunId });
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
 * Resume a run after a human has decided a pending approval. If approved,
 * executes the originally-requested tool call and — if this was the run's
 * last outstanding approval — completes the agent_run. If rejected, marks
 * the tool call denied and completes the run the same way.
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
    const planned: PlannedToolCall = { toolName: toolCall.toolName, action: toolCall.action, input: toolCall.requestSummary };
    updatedToolCall = await executeToolCall(tools, planned, toolCall, tenantId, approval.agentRunId, toolCallStore);
    await approvalStore.decide(tenantId, approvalId, {
      status: "executed",
      executionResult: updatedToolCall.responseSummary ?? {},
    });
  } else {
    updatedToolCall = await toolCallStore.update(tenantId, toolCall.id, {
      status: "denied",
      error: `approval ${approval.status}`,
      completedAt: new Date().toISOString(),
    });
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
