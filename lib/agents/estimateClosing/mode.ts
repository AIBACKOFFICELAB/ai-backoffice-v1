export const ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID = "estimate_closing_shadow";

/**
 * Shadow vs. active labeling for the AI Activity page and dashboard
 * feed (P1B "AI Activity Experience" / "Shadow Mode UX"). Derived from
 * the run's workflowId — the Estimate Closing Agent (Shadow Mode) always
 * uses ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID (see shadowRunner.ts). This is
 * a UI labeling helper, not a security boundary — the actual shadow-mode
 * safety guarantee is structural (shadowRunner.ts has no toolPlan
 * parameter at all), not this label.
 */
export function modeForRunWorkflow(workflowId: string | null): "shadow" | "active" {
  return workflowId === ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID ? "shadow" : "active";
}
