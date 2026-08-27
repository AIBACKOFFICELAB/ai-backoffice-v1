/**
 * Tool definitions — the SECURITY AUTHORITY for what a tool is allowed to
 * do (Codex P0 acceptance audit finding B-02). A registered ToolDefinition
 * owns its own permission classification, scopes, and autonomy floor; the
 * runtime (lib/agents/runtime.ts) derives authorization entirely from this
 * definition via lib/agents/permissions.ts::evaluateToolCall — a caller
 * supplies only {toolName, action, input}, never a permission. See
 * docs/AGENT_SECURITY.md.
 *
 * These three tools are unchanged in *behavior* from pre-Slice-A — none
 * touch a customer, send anything, or modify tenant business data. Slice A
 * adds security metadata to them; it does not introduce new consequential
 * tools (explicitly out of scope — see the P0.9 Slice A directive).
 */

import { AutonomyTier, Permission } from "./types";

export type ToolContext = { tenantId: string; agentRunId: string };
export type ToolResult = { ok: boolean; summary: Record<string, unknown>; error?: string };
export type ToolValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** What kind of effect invoking this tool has, for audit/classification. */
export type ToolEffectClass = "read" | "internal_write" | "external_communication" | "financial" | "destructive" | "approval_action";
/** Whether invoking this tool can affect anything outside AI BackOffice's own internal records. */
export type ToolSideEffectClass = "none" | "internal_only" | "customer_facing";

export interface ToolDefinition<TInput = Record<string, unknown>> {
  name: string;
  /** Bumped whenever this definition's security-relevant shape changes. */
  version: number;
  /** The one true permission this tool represents. This is what
   * evaluateToolCall reads — there is no caller-supplied alternative. */
  intrinsicPermission: Permission;
  effectClass: ToolEffectClass;
  sideEffectClass: ToolSideEffectClass;
  requiredReadScopes: string[];
  requiredWriteScopes: string[];
  /** Floor under agent.approval_policy[name] — independent of, and
   * combined with, the Permission-based floor in permissions.ts. A tool
   * author can force at least REQUIRE_APPROVAL regardless of how an
   * individual agent is configured. */
  minimumAutonomyTier: AutonomyTier;
  /** Runs before execute() and before an approval is ever created — a
   * malformed request fails immediately, it never reaches a human or the
   * tool body. */
  validateInput(input: unknown): ToolValidation<TInput>;
  /** Optional; best-effort output shape check. Not fatal in P0 — logged by
   * the caller, not enforced as a hard failure. */
  validateOutput?(output: unknown): { ok: true } | { ok: false; errors: string[] };
  /** Whether calling execute() twice with the same input is safe. None of
   * the P0 tools have external side effects, so all three are technically
   * idempotent; this field exists for the tools that won't be. */
  idempotent: boolean;
  execute(input: TInput, ctx: ToolContext): Promise<ToolResult>;
}

/** Registry-typed alias — a map of heterogeneous tools necessarily erases
 * each tool's precise input type; individual tool constants below keep
 * their real type. */
export type AnyToolDefinition = ToolDefinition<any>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pure no-op — proves the pipeline end-to-end with zero side effects. */
export const pingTool: ToolDefinition<Record<string, unknown>> = {
  name: "ping",
  version: 1,
  intrinsicPermission: "EXECUTE",
  effectClass: "read",
  sideEffectClass: "none",
  requiredReadScopes: [],
  requiredWriteScopes: [],
  minimumAutonomyTier: "AUTO_EXECUTE",
  idempotent: true,
  validateInput(input) {
    // ping accepts any object shape (including {}) — its only job is a
    // no-op round trip proving the pipeline works.
    return { ok: true, value: isRecord(input) ? input : {} };
  },
  async execute(input, ctx) {
    return { ok: true, summary: { pong: true, receivedAt: new Date().toISOString(), tenantId: ctx.tenantId, input } };
  },
};

/** Appends a note to the agent run's own record only — never touches
 * customer-facing data, which is why AUTO_EXECUTE_AND_LOG is a safe floor
 * for it. */
export const createInternalNoteTool: ToolDefinition<{ note: string }> = {
  name: "create_internal_note",
  version: 1,
  intrinsicPermission: "WRITE",
  effectClass: "internal_write",
  sideEffectClass: "internal_only",
  requiredReadScopes: [],
  requiredWriteScopes: [],
  minimumAutonomyTier: "AUTO_EXECUTE_AND_LOG",
  idempotent: false,
  validateInput(input) {
    if (!isRecord(input) || typeof input.note !== "string" || input.note.trim() === "") {
      return { ok: false, errors: ["note is required and must be a non-empty string"] };
    }
    return { ok: true, value: { note: input.note } };
  },
  async execute(input) {
    return { ok: true, summary: { note: input.note } };
  },
};

/** Drafts (never sends) a customer-facing message. intrinsicPermission is
 * SEND and minimumAutonomyTier is REQUIRE_APPROVAL — both are floors a
 * caller cannot lower by relabeling the call as EXECUTE, because there is
 * no label to send; see lib/agents/permissions.test.ts. */
export const draftCustomerMessageTool: ToolDefinition<{ draft: string }> = {
  name: "draft_customer_message",
  version: 1,
  intrinsicPermission: "SEND",
  effectClass: "external_communication",
  sideEffectClass: "customer_facing",
  requiredReadScopes: [],
  requiredWriteScopes: [],
  minimumAutonomyTier: "REQUIRE_APPROVAL",
  idempotent: false,
  validateInput(input) {
    if (!isRecord(input) || typeof input.draft !== "string") {
      return { ok: false, errors: ["draft is required and must be a string"] };
    }
    return { ok: true, value: { draft: input.draft } };
  },
  async execute(input) {
    return { ok: true, summary: { draft: input.draft } };
  },
};

export const DEFAULT_TOOL_REGISTRY: Record<string, AnyToolDefinition> = {
  [pingTool.name]: pingTool,
  [createInternalNoteTool.name]: createInternalNoteTool,
  [draftCustomerMessageTool.name]: draftCustomerMessageTool,
};
