import { describe, it, expect } from "vitest";
import { modeForRunWorkflow, ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID } from "./mode";

describe("modeForRunWorkflow", () => {
  it('labels the Estimate Closing Agent\'s workflow as "shadow"', () => {
    expect(modeForRunWorkflow(ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID)).toBe("shadow");
  });

  it('labels every other workflow id as "active"', () => {
    expect(modeForRunWorkflow("some_other_workflow")).toBe("active");
    expect(modeForRunWorkflow(null)).toBe("active");
  });
});
