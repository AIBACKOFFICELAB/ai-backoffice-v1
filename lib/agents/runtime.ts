import { createHash } from "crypto";
import { Agent } from "./types";
import { AgentStore, SupabaseAgentStore } from "./agentStore";
import { AgentRun, AgentRunStore, SupabaseAgentRunStore } from "./runStore";
import { ToolCall, ToolCallStore, SupabaseToolCallStore } from "./toolCallStore";
import { evaluateToolCall, buildPolicySnapshot, PolicyDecision } from "./permissions";
import { computeRunStatus } from "./runStatus";
import { DEFAULT_TOOL_REGISTRY, AnyToolDefinition, conservativeAuditFallback, summarizeForAudit } from "./toolRegistry";
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

/**
 * Privacy-safe fingerprint of a model response's raw text (P0.9 Slice C
 * correction 3), persisted into agent_runs.output_summary IN PLACE OF the
 * raw text itself. The prompt/response text can carry customer PII (a
 * phone number, an email, message content) — that must never land in a
 * durable audit column merely because we wanted SOME record that a model
 * call happened. Same SHA-256 pattern as
 * lib/agents/permissions.ts::hashInstructions: deterministic, so identical
 * text always fingerprints identically (useful for detecting duplicate/
 * cached responses) and any change to the text changes the digest. The
 * character count is retained (not the text) purely as a coarse, harmless
 * shape signal. This is NEVER read back as an execution payload — the full
 * response text lives only in memory for the duration of this one call.
 */
function fingerprintModelOutput(text: string): string {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return `sha256:${digest};chars:${text.length}`;
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
      // P0.9 Slice C correction 3: a privacy-safe fingerprint, never the
      // raw response text (which may carry customer PII) — see
      // fingerprintModelOutput above.
      outputSummary: fingerprintModelOutput(response.text),
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

  for (const planned of input.toolPlan) {
    const tool = tools[planned.toolName];

    if (!tool) {
      // No ToolDefinition exists to evaluate — build the deny decision by
      // hand (evaluateToolCall requires a registered tool) so this call
      // still gets an immutable policy snapshot like every other tool_call
      // (P0.9 Slice B, finding B-08).
      const decision: PolicyDecision = { decision: "deny", reason: `tool '${planned.toolName}' is not registered` };
      const toolCall = await toolCallStore.create({
        tenantId: input.tenantId,
        agentRunId: agentRun.id,
        toolName: planned.toolName,
        action: planned.action,
        // P0.9 Slice C correction 2: no ToolDefinition exists for an
        // unregistered tool name, so there's no per-tool summarizer to even
        // consult — always the conservative structural fallback, never the
        // raw caller-supplied input.
        requestSummary: conservativeAuditFallback(planned.input),
        requiresApproval: false,
        policySnapshot: buildPolicySnapshot(agent, null, planned.toolName, planned.action, decision),
      });
      const updated = await toolCallStore.update(input.tenantId, toolCall.id, {
        status: "failed",
        error: decision.reason,
        completedAt: new Date().toISOString(),
      });
      outcomes.push({ toolCall: updated, approval: null });
      continue;
    }

    const decision = evaluateToolCall(agent, tool);

    // P0.9 Slice C, finding H-05/C.5: tool_calls.request_summary is a
    // privacy-minimized AUDIT representation, computed from the raw
    // planned input, before validation — it is NEVER what gets executed.
    // For an approval-gated call, approvals.payload (set below,
    // unminimized) is the sole canonical resumable execution payload; for
    // an AUTO_EXECUTE call, execution reads the in-memory validated input
    // directly (see the "allow" branch below), never this summary either.
    // P0.9 Slice C correction 2B: routed through summarizeForAudit, never
    // the tool's summarizer directly — this runs on the RAW planned input,
    // BEFORE validateInput below, so a summarizer that throws on a
    // malformed shape must never crash the run; summarizeForAudit catches
    // that and falls back to conservativeAuditFallback.
    const auditRequestSummary = summarizeForAudit(tool.summarizeInputForAudit, planned.input);

    const toolCall = await toolCallStore.create({
      tenantId: input.tenantId,
      agentRunId: agentRun.id,
      toolName: tool.name,
      action: planned.action,
      requestSummary: auditRequestSummary,
      requiresApproval: decision.decision === "require_approval",
      policySnapshot: buildPolicySnapshot(agent, tool, tool.name, planned.action, decision),
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
  }

  // P0.9 Slice B, finding B-07: truthful terminal status, computed by the
  // single centralized rule in lib/agents/runStatus.ts — never scattered
  // ad hoc booleans. 'awaiting_approval' still short-circuits everything
  // else, same as before Slice B: computeRunStatus is only meaningful once
  // no tool call is still pending a human decision.
  const finalStatus = anyAwaitingApproval ? "awaiting_approval" : computeRunStatus(outcomes.map((o) => o.toolCall.status));
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
    // P0.9 Slice C, finding H-05/C.5: what gets PERSISTED may be
    // privacy-minimized; the succeeded/failed decision and validateOutput
    // below always evaluate the RAW result.summary, never this audit
    // summary — summarization must never alter actual tool result
    // handling.
    const auditResponseSummary = summarizeForAudit(tool.summarizeOutputForAudit, result.summary);

    if (!result.ok) {
      return toolCallStore.update(tenantId, toolCall.id, {
        status: "failed",
        responseSummary: auditResponseSummary,
        error: result.error ?? null,
        completedAt: new Date().toISOString(),
      });
    }

    // P0.9 Slice B, finding B-09: the tool's own declared validateOutput
    // contract, where present, is enforced here — a malformed response is
    // never recorded as an ordinary success just because the tool itself
    // claimed result.ok === true.
    if (tool.validateOutput) {
      const outputValidation = tool.validateOutput(result.summary);
      if (!outputValidation.ok) {
        return toolCallStore.update(tenantId, toolCall.id, {
          status: "failed",
          responseSummary: auditResponseSummary,
          error: `output validation failed: ${outputValidation.errors.join("; ")}`,
          completedAt: new Date().toISOString(),
        });
      }
    }

    return toolCallStore.update(tenantId, toolCall.id, {
      status: "succeeded",
      responseSummary: auditResponseSummary,
      error: null,
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
 * A failed claim is handled according to WHY it failed (see
 * diagnoseExecutionRefusal): losing a race to a concurrent resume call
 * that already owns or has already consumed the approval is a SAFE NO-OP
 * — the tool_call is read back fresh and returned unchanged, never
 * overwritten with 'failed', because the legitimate winner may still be
 * mid-flight or may have already recorded a real success. Only a genuine
 * integrity problem — the payload no longer matches what was approved, or
 * the tool is no longer registered — marks the tool_call failed. A
 * diagnostic (non-authoritative) read is used only to tell these apart and
 * to build a clearer error message; it is never what decides whether
 * execution proceeds.
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
    // P0.9 Slice B, finding B-07: same centralized rule as runAgent() — a
    // run resumed after a rejected approval must never silently resolve to
    // 'succeeded'. See lib/agents/runStatus.ts.
    await runStore.update(tenantId, approval.agentRunId, {
      status: computeRunStatus(remaining.map((tc) => tc.status)),
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
    // Genuine integrity problem — the approval references a tool that no
    // longer exists in the registry. Not a race; always mark failed.
    return toolCallStore.update(tenantId, toolCall.id, {
      status: "failed",
      error: `tool '${toolCall.toolName}' is not registered`,
      completedAt: new Date().toISOString(),
    });
  }

  // P0.9 Slice C, finding H-05/C.5: execute from approval.payload — the
  // canonical, unminimized resumable execution payload — never from
  // toolCall.requestSummary, which is now a privacy-minimized AUDIT
  // summary that may not even be shaped like valid tool input (see
  // ToolDefinition.summarizeInputForAudit). This also means the payload-
  // binding digest recomputed below detects tampering with approval.payload
  // itself (the actual execution surface), not tampering with the audit
  // summary — mutating the audit record can no longer authorize different
  // execution data, by construction.
  const expectedDigest = computePayloadDigest({
    tenantId: approval.tenantId,
    agentId: approval.agentId,
    agentRunId: approval.agentRunId,
    toolName: toolCall.toolName,
    action: toolCall.action,
    payload: approval.payload,
  });

  const claimed = await approvalStore.beginExecution(tenantId, approval.id, expectedDigest);
  if (!claimed) {
    const diagnosis = await diagnoseExecutionRefusal(tenantId, approval.id, expectedDigest, approvalStore);

    if (diagnosis.kind === "benign_race") {
      // Another executor already owns (or has already consumed) this
      // approval — this caller simply lost the race, which is expected
      // and correct, not an error. It must NEVER mutate the shared
      // tool_call: the legitimate winner is either still mid-flight or has
      // already recorded the real outcome, and overwriting either with
      // 'failed' would corrupt a call that actually succeeded. Return the
      // current, freshly-read state instead of the (possibly stale)
      // reference this function was called with.
      return (await toolCallStore.getByApprovalId(tenantId, approval.id)) ?? toolCall;
    }

    // Genuine integrity problem (payload tampered, or an otherwise
    // unreachable state) — this IS this caller's failure to report.
    return toolCallStore.update(tenantId, toolCall.id, {
      status: "failed",
      error: `execution refused: ${diagnosis.reason}`,
      completedAt: new Date().toISOString(),
    });
  }

  // Validate and execute from approval.payload (the approved execution
  // payload), never toolCall.requestSummary — see the doc comment above.
  const validation = tool.validateInput(approval.payload);
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

type ExecutionRefusalDiagnosis =
  | { kind: "benign_race"; reason: string }
  | { kind: "integrity_failure"; reason: string };

/**
 * Diagnostic-only read to explain a failed beginExecution claim — never
 * used to decide whether to proceed, that decision was already made
 * atomically by the compare-and-swap itself. Distinguishes two cases the
 * caller must treat very differently:
 *
 * - `benign_race`: another executor already owns (`executing`) or has
 *   already consumed (`executed`) this approval. Expected under
 *   concurrency, not a fault — the caller must NOT mutate the tool_call.
 * - `integrity_failure`: something is actually wrong (the payload no
 *   longer matches what was approved, or an approval was somehow claimed
 *   against before it was even approved) — the caller marks the tool_call
 *   failed with this reason.
 */
async function diagnoseExecutionRefusal(
  tenantId: string,
  approvalId: string,
  expectedDigest: string,
  approvalStore: ApprovalStore
): Promise<ExecutionRefusalDiagnosis> {
  const current = await approvalStore.getById(tenantId, approvalId);
  if (!current) {
    // An approval row disappearing entirely is not a state this codebase
    // can produce — there is no delete path. Treat as an integrity
    // problem rather than silently doing nothing.
    return { kind: "integrity_failure", reason: "approval no longer exists" };
  }
  if (current.status === "executing" || current.status === "executed") {
    return { kind: "benign_race", reason: `approval is '${current.status}' — another executor already owns or has consumed it` };
  }
  if (current.status !== "approved") {
    // pending/rejected/expired at claim time — not reachable via the
    // normal 'approved' routing in resumeAfterApprovalDecision, but
    // defensively an integrity problem if it ever is.
    return { kind: "integrity_failure", reason: `approval is '${current.status}', not 'approved'` };
  }
  if (current.payloadDigest !== expectedDigest) {
    return {
      kind: "integrity_failure",
      reason: "payload binding verification failed — the tool call's recorded input no longer matches what was approved",
    };
  }
  // Status is 'approved' and the digest matches, yet the CAS still lost —
  // the only explanation is a race whose resolution hasn't been observed
  // by this diagnostic read yet. Benign: never mutate the tool_call for
  // this.
  return { kind: "benign_race", reason: "lost a concurrent claim to execute this approval" };
}
