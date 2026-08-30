/**
 * P1A production activation gate — a hard boundary, not a policy default,
 * mirroring lib/ai/environment.ts::isMockProviderAllowed()'s "no
 * environment-variable override that isn't explicit" design.
 *
 * Fail-closed by construction: any value other than the exact string
 * "true" (including unset, empty, "1", "TRUE", a typo) is treated as
 * disabled. This cannot be flipped by visiting a route or by a database
 * row edit alone — see AGENT_SECURITY.md's autonomy-tier model for why an
 * agent's own `status` row is a separate, insufficient gate on its own:
 * this flag is checked IN ADDITION to agent.status === 'active', not
 * instead of it (see shadowRunner.ts::triggerEstimateClosingShadow).
 *
 * ACTIVATION PROCEDURE (do not perform without founder approval — see the
 * P1 Sprint 1 directive's "Production Rule" and "Feature Enablement"
 * sections):
 *   1. Seed the tenant's estimate_closing agent row (status: 'inactive'
 *      initially — see lib/agents/seed.ts for the createIfAbsent pattern
 *      this would extend; NOT done in this sprint):
 *        agentStore.createIfAbsent({ tenantId, agentType: "estimate_closing", status: "inactive", ... })
 *   2. Explicitly set the row's status to 'active' for that tenant only
 *      (owner-authorized action, not part of seeding).
 *   3. Set ESTIMATE_CLOSING_SHADOW_ENABLED=true in the Vercel production
 *      environment (a deploy-time config change, not a runtime toggle).
 *   4. Wire app/api/agents/estimate-closing/scan/route.ts into
 *      vercel.json's `crons` array (it exists and is CRON_SECRET-gated,
 *      but is deliberately NOT yet listed there — see that file).
 * All four steps are required; any one left undone keeps production
 * disabled.
 */
export function isEstimateClosingShadowEnabled(): boolean {
  return process.env.ESTIMATE_CLOSING_SHADOW_ENABLED === "true";
}
