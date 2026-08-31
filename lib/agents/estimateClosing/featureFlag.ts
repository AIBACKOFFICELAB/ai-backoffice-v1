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
 * P1 Sprint 1/2 directives' "Production Rule" and "Feature Enablement"
 * sections):
 *   1. Register the tenant's estimate_closing agent row (status:
 *      'inactive' initially) — use
 *      lib/agents/estimateClosing/registration.ts::ensureEstimateClosingAgent(tenantId),
 *      NOT lib/agents/seed.ts::seedAgents (that function also creates an
 *      unrelated dev_test agent as a side effect — see registration.ts's
 *      own doc comment for why a dedicated primitive exists). The operator
 *      script at scripts/register-estimate-closing-agent.mjs performs
 *      exactly this step for one explicit tenant id; NOT run against
 *      production as part of any sprint so far.
 *   2. Explicitly set the row's status to 'active' for that tenant only
 *      (owner-authorized action, not part of registration).
 *   3. Set ESTIMATE_CLOSING_SHADOW_ENABLED=true in the Vercel production
 *      environment (a deploy-time config change, not a runtime toggle).
 * All three steps are required; any one left undone keeps production
 * disabled.
 *
 * P1 Sprint 2 note: app/api/agents/estimate-closing/scan/route.ts is now
 * WIRED into vercel.json's `crons` array (a conservative daily schedule,
 * scheduled after the Estimate Follow-up cron) — cron wiring is no longer
 * one of the required activation steps above. Being scheduled does not
 * activate anything: the route itself checks this exact flag first and
 * returns before any database read, model call, or event write whenever
 * it isn't exactly "true" (see the route's own doc comment). A disabled
 * route firing on schedule is a safe, cheap no-op, by design.
 */
export function isEstimateClosingShadowEnabled(): boolean {
  return process.env.ESTIMATE_CLOSING_SHADOW_ENABLED === "true";
}
