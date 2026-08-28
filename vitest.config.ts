import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config — first test runner in this repo (see
 * docs/constitution/09_DEVELOPMENT_STANDARDS.md: "establishing one is a
 * prerequisite task, not a parallel nice-to-have"). Scoped to pure
 * unit/integration tests against dependency-injected fakes; nothing here
 * talks to a live database or a live model provider (see AGENT_SECURITY.md /
 * MODEL_GATEWAY.md for how the in-memory stores/mock provider make that
 * possible).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
