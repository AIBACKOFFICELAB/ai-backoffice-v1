import { NextRequest, NextResponse } from "next/server";
import { runEstimateClosingShadowSweep } from "./stalledScan";
import { isEstimateClosingShadowEnabled } from "./featureFlag";

/**
 * P1A trigger route logic — Estimate Closing Agent, Shadow Mode. Lives here
 * (not inline in app/api/agents/estimate-closing/scan/route.ts) because
 * Next.js's App Router only permits a fixed set of named exports from a
 * route.ts file (HTTP method handlers + a small config set) — anything
 * else fails the framework's own generated route type-check. This mirrors
 * the repo's existing convention of keeping route.ts files thin and
 * putting real logic in lib/ (see lib/modules/estimateFollowup/service.ts,
 * called from app/api/modules/estimate-followup/trigger/route.ts).
 *
 * P1 Sprint 2: now wired into vercel.json's `crons` array (a conservative
 * daily schedule, after the Estimate Follow-up cron has had time to run —
 * see vercel.json and featureFlag.ts's updated activation-procedure doc
 * comment). Cron wiring is no longer an activation prerequisite — it is
 * scheduled, but this handler remains fail-closed: with
 * ESTIMATE_CLOSING_SHADOW_ENABLED unset/not exactly "true", every scheduled
 * invocation returns immediately before any database read, model call, or
 * event write. Activation still requires all of: (1) the estimate_closing
 * agent row exists, (2) its status is explicitly 'active', (3) the
 * environment variable is set — see featureFlag.ts.
 *
 * Fail-closed at the route level, not just inside the shadow runner: if
 * the production flag is off, this returns immediately — no database
 * read, no event emitted, no model call — rather than running the
 * (harmless on its own, but still real) stalled-estimate scan and only
 * skipping the model-reasoning step. "If production enablement flag is
 * false: do nothing" is read here as the whole pipeline, not just its
 * model-call leg.
 */
export function isAuthorizedCron(request: NextRequest): boolean {
  if (!process.env.CRON_SECRET) return false;
  const authHeader = request.headers.get("authorization");
  const legacyHeader = request.headers.get("x-cron-secret");
  return authHeader === `Bearer ${process.env.CRON_SECRET}` || legacyHeader === process.env.CRON_SECRET;
}

export type ScanRouteDeps = {
  isEnabled?: () => boolean;
  runSweep?: typeof runEstimateClosingShadowSweep;
};

export async function handleScanRequest(request: NextRequest, deps: ScanRouteDeps = {}): Promise<NextResponse> {
  const isEnabled = deps.isEnabled ?? isEstimateClosingShadowEnabled;
  const runSweep = deps.runSweep ?? runEstimateClosingShadowSweep;

  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  if (!isEnabled()) {
    return NextResponse.json({ ok: true, fired: false, reason: "estimate_closing_shadow_disabled" });
  }

  const result = await runSweep();

  // Deliberately summary-only: no rationale, no recommendation payload
  // detail, no customer identifiers beyond what's already an id — this
  // response may end up in Vercel's own request logs, which are outside
  // this codebase's privacy-minimization guarantees for durable app data.
  return NextResponse.json({
    ok: true,
    fired: true,
    candidatesScanned: result.scan.candidatesScanned,
    stalledFound: result.scan.stalledFound,
    newEventsThisSweep: result.scan.stalledCandidates.filter((c) => c.isNewEvent).length,
    shadowAttempts: result.shadowOutcomes.length,
    outcomes: result.shadowOutcomes.map(({ outcome }) => outcome.status),
  });
}
