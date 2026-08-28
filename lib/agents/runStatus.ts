import { ToolCallStatus } from "./toolCallStore";
import { AgentRunStatus } from "./runStore";

/**
 * Centralized, testable agent-run terminal-status computation (P0.9 Slice B,
 * finding B-07). Before Slice B this decision was made twice, ad hoc, inline
 * in lib/agents/runtime.ts — once in runAgent() and again, separately, in
 * resumeAfterApprovalDecision() — and neither computation distinguished a
 * denied tool call from a merely-absent failure, so a run whose only tool
 * calls were all denied by policy reported 'succeeded'. Both call sites now
 * call computeRunStatus() below; there is exactly one place this rule is
 * defined.
 *
 * Deterministic rule, in priority order:
 *   1. Any 'failed' tool call (a genuine execution error, or a request that
 *      never even reached policy evaluation because the tool wasn't
 *      registered / input was malformed) -> 'failed'. Failure always wins
 *      over partial or denied, documented tie-break: a run that actually
 *      broke should never be reported as merely "some things were denied."
 *   2. No failures, but at least one 'denied' AND at least one 'succeeded'
 *      -> 'partial'.
 *   3. No failures, no successes, at least one 'denied' -> 'denied'.
 *   4. Otherwise (including the vacuous case of zero tool calls, and the
 *      case where every tool call succeeded) -> 'succeeded'.
 *
 * 'requires_approval' and 'pending' are non-terminal and are intentionally
 * excluded from this computation — callers only invoke this once no tool
 * call is still awaiting a decision (see runtime.ts's `stillWaiting` /
 * `anyAwaitingApproval` gating, which is unchanged by Slice B).
 */
export type ToolCallStatusCounts = {
  succeeded: number;
  failed: number;
  denied: number;
  requiresApproval: number;
  pending: number;
};

export function summarizeToolCallStatuses(statuses: ToolCallStatus[]): ToolCallStatusCounts {
  const counts: ToolCallStatusCounts = { succeeded: 0, failed: 0, denied: 0, requiresApproval: 0, pending: 0 };
  for (const status of statuses) {
    if (status === "succeeded") counts.succeeded += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "denied") counts.denied += 1;
    else if (status === "requires_approval") counts.requiresApproval += 1;
    else if (status === "pending") counts.pending += 1;
  }
  return counts;
}

/**
 * Computes the terminal AgentRunStatus for a run whose tool calls have all
 * reached a terminal state (or approval-awaiting handling — see module doc
 * above). Pure, synchronous, and independently unit-testable
 * (lib/agents/runStatus.test.ts) — no I/O, no dependency on the runtime.
 */
export function computeRunStatus(statuses: ToolCallStatus[]): Extract<AgentRunStatus, "succeeded" | "failed" | "denied" | "partial"> {
  const counts = summarizeToolCallStatuses(statuses);
  if (counts.failed > 0) return "failed";
  if (counts.denied > 0 && counts.succeeded > 0) return "partial";
  if (counts.denied > 0) return "denied";
  return "succeeded";
}
