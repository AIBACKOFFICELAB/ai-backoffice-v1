import { NextRequest, NextResponse } from "next/server";
import { runEstimateClosingShadowSweep } from "@/lib/agents/estimateClosing/stalledScan";
import { isEstimateClosingShadowEnabled } from "@/lib/agents/estimateClosing/featureFlag";

export const dynamic = "force-dynamic";

/**
 * P1A trigger route — Estimate Closing Agent, Shadow Mode.
 *
 * NOT wired into vercel.json's `crons` array. It exists, is fully tested,
 * and is safe to call, but nothing in this deployment invokes it
 * automatically — see lib/agents/estimateClosing/featureFlag.ts's
 * "ACTIVATION PROCEDURE" doc comment for the exact steps (cron wiring
 * being one of four) required before this ever fires in production. This
 * is deliberate: the P1 Sprint 1 directive requires the safe mechanism to
 * exist and the activation procedure to be documented, while production
 * stays disabled without separate founder approval.
 *
 * Fail-closed at the route level, not just inside the shadow runner: if
 * the production flag is off, this returns immediately — no database
 * read, no event emitted, no model call — rather than running the
 * (harmless on its own, but still real) stalled-estimate scan and only
 * skipping the model-reasoning step. "If production enablement flag is
 * false: do nothing" is read here as the whole pipeline, not just its
 * model-call leg.
 */
function isAuthorizedCron(request: NextRequest): boolean {
  if (!process.env.CRON_SECRET) return false;
  const authHeader = request.headers.get("authorization");
  const legacyHeader = request.headers.get("x-cron-secret");
  return authHeader === `Bearer ${process.env.CRON_SECRET}` || legacyHeader === process.env.CRON_SECRET;
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  if (!isEstimateClosingShadowEnabled()) {
    return NextResponse.json({ ok: true, fired: false, reason: "estimate_closing_shadow_disabled" });
  }

  const result = await runEstimateClosingShadowSweep();

  // Deliberately summary-only: no rationale, no recommendation payload
  // detail, no customer identifiers beyond what's already an id — this
  // response may end up in Vercel's own request logs, which are outside
  // this codebase's privacy-minimization guarantees for durable app data.
  return NextResponse.json({
    ok: true,
    fired: true,
    candidatesScanned: result.scan.candidatesScanned,
    stalledFound: result.scan.stalledFound,
    newlyTriggered: result.scan.newlyEmitted.length,
    outcomes: result.shadowOutcomes.map(({ outcome }) => outcome.status),
  });
}
