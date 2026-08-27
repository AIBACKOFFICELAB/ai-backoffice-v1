import { describe, it, expect } from "vitest";
import { resolveRoute } from "./router";

describe("resolveRoute", () => {
  it("prefers anthropic when it's available", () => {
    const route = resolveRoute({ tenantId: "t1" }, "generate", ["mock", "anthropic"]);
    expect(route.provider).toBe("anthropic");
  });

  it("falls back to whatever is available when anthropic isn't configured", () => {
    const route = resolveRoute({ tenantId: "t1" }, "generate", ["mock"]);
    expect(route.provider).toBe("mock");
  });

  it("picks a cheaper/faster model when costPreference or latencyPreference asks for it", () => {
    const route = resolveRoute({ tenantId: "t1", costPreference: "low" }, "generate", ["anthropic"]);
    expect(route.model).toBe("claude-haiku-4-5-20251001");
  });

  it("picks a higher-capability model for high complexity / quality latency", () => {
    const route = resolveRoute({ tenantId: "t1", complexity: "high" }, "reason", ["anthropic"]);
    expect(route.model).toBe("claude-opus-5");
  });

  it("defaults classify to the cheap model when no complexity is specified", () => {
    const route = resolveRoute({ tenantId: "t1" }, "classify", ["anthropic"]);
    expect(route.model).toBe("claude-haiku-4-5-20251001");
  });

  it("defaults to the balanced model otherwise", () => {
    const route = resolveRoute({ tenantId: "t1" }, "generate", ["anthropic"]);
    expect(route.model).toBe("claude-sonnet-5");
  });
});
