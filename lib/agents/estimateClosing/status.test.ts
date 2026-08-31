import { describe, it, expect } from "vitest";
import { resolveEstimateClosingAgentStatus } from "./status";

describe("resolveEstimateClosingAgentStatus", () => {
  it("returns 'not_registered' when no estimate_closing agent row exists", () => {
    expect(resolveEstimateClosingAgentStatus([])).toBe("not_registered");
    expect(resolveEstimateClosingAgentStatus([{ agentType: "dev_test", status: "active" }])).toBe("not_registered");
  });

  it("returns 'inactive' when the row exists but its status is not 'active'", () => {
    expect(resolveEstimateClosingAgentStatus([{ agentType: "estimate_closing", status: "inactive" }])).toBe("inactive");
    expect(resolveEstimateClosingAgentStatus([{ agentType: "estimate_closing", status: "paused" }])).toBe("inactive");
    expect(resolveEstimateClosingAgentStatus([{ agentType: "estimate_closing", status: "archived" }])).toBe("inactive");
  });

  it("returns 'active' only when the row's status is exactly 'active'", () => {
    expect(resolveEstimateClosingAgentStatus([{ agentType: "estimate_closing", status: "active" }])).toBe("active");
  });

  it("is unaffected by other agent rows present for the tenant", () => {
    const agents = [
      { agentType: "dev_test", status: "active" },
      { agentType: "supervisor", status: "inactive" },
      { agentType: "estimate_closing", status: "active" },
    ] as const;
    expect(resolveEstimateClosingAgentStatus([...agents])).toBe("active");
  });
});
