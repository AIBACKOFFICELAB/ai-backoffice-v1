/**
 * Mock/safe tools used to prove the agent runtime (P0.3 exit criteria: "Mock/
 * safe tool called"). None of these touch a customer, send anything, or
 * modify tenant business data — that's deliberate. Real tools (send SMS,
 * update a lead, issue a refund) are a P1 concern layered on top of this
 * same registry shape once a real agent needs them, per docs/AGENT_SECURITY.md.
 */

export type ToolContext = { tenantId: string; agentRunId: string };
export type ToolResult = { ok: boolean; summary: Record<string, unknown>; error?: string };

export interface Tool {
  name: string;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Pure no-op — proves the pipeline end-to-end with zero side effects. */
export const pingTool: Tool = {
  name: "ping",
  async execute(input, ctx) {
    return { ok: true, summary: { pong: true, receivedAt: new Date().toISOString(), tenantId: ctx.tenantId, input } };
  },
};

/** Appends a note to the agent run's own record only — never touches
 * customer-facing data, which is why it's safe to configure
 * AUTO_EXECUTE_AND_LOG on the dev/test agent. */
export const createInternalNoteTool: Tool = {
  name: "create_internal_note",
  async execute(input) {
    const note = typeof input.note === "string" ? input.note : "";
    if (!note) return { ok: false, summary: {}, error: "note is required" };
    return { ok: true, summary: { note } };
  },
};

/** Drafts (never sends) a customer-facing message. Configured
 * REQUIRE_APPROVAL on the dev/test agent so the approval-enforcement path
 * has a real example to exercise — see docs/AGENT_SECURITY.md and
 * lib/agents/runtime.test.ts. */
export const draftCustomerMessageTool: Tool = {
  name: "draft_customer_message",
  async execute(input) {
    const draft = typeof input.draft === "string" ? input.draft : "";
    return { ok: true, summary: { draft } };
  },
};

export const DEFAULT_TOOL_REGISTRY: Record<string, Tool> = {
  [pingTool.name]: pingTool,
  [createInternalNoteTool.name]: createInternalNoteTool,
  [draftCustomerMessageTool.name]: draftCustomerMessageTool,
};
