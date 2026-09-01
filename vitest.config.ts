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
 *
 * P1 Sprint 3: `oxc.jsx` is set explicitly because tsconfig.json's
 * `jsx: "preserve"` (correct for Next.js, whose own build pipeline does
 * the JSX transform) otherwise leaves Vite's transform with no JSX
 * handling of its own — harmless for every existing `**\/*.test.ts` file
 * (none import a `.tsx` module), but required the moment a test needs to
 * render a real presentational component via react-dom/server's
 * renderToStaticMarkup (see components/ai/ApprovalModeLadder.test.ts /
 * ApprovalReadinessEvidence.test.ts) — this repo still has no
 * component-testing library, so that is the lowest-dependency way to
 * assert on real rendered output. This vitest version transforms via oxc,
 * not esbuild — oxc is the option that actually takes effect.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  oxc: {
    jsx: { runtime: "automatic" },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
  },
});
