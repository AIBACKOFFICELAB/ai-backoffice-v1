import { createHash } from "crypto";

/**
 * Deterministic payload binding (Codex P0 acceptance audit finding B-03).
 * Computed once at approval-request time (lib/agents/runtime.ts) and
 * recomputed at execution time from the approval's own stored tenant/agent/
 * run identity plus the CURRENT tool_calls row
 * (lib/agents/runtime.ts::resumeAfterApprovalDecision). Any mutation to
 * tool_calls.request_summary (or a mismatched tenant/agent/run/tool/action)
 * between those two points changes the recomputed digest, and
 * lib/approvals/store.ts::beginExecution's compare-and-swap refuses to
 * transition when the digests don't match — this is what stops "approval
 * UI reviews payload A, tool executes modified payload B." See
 * docs/AGENT_SECURITY.md.
 */

export type PayloadBindingInput = {
  tenantId: string;
  agentId: string | null;
  agentRunId: string | null;
  toolName: string;
  action: string;
  payload: Record<string, unknown>;
};

/**
 * Deterministic JSON serialization with recursively sorted object keys, so
 * the digest doesn't depend on property insertion order. Array element
 * order IS preserved — order is meaningful for arrays, not for object key
 * ordering.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

/** SHA-256 hex digest binding an approval to exactly the tenant, agent,
 * agent run, tool, action, and payload it was requested for. */
export function computePayloadDigest(input: PayloadBindingInput): string {
  const canonical = stableStringify({
    tenantId: input.tenantId,
    agentId: input.agentId,
    agentRunId: input.agentRunId,
    toolName: input.toolName,
    action: input.action,
    payload: input.payload,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
