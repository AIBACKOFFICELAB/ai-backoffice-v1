import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { getTenantContext, TenantContext } from "@/lib/tenant";
import { recordEstimateClosingRecommendationFollowThrough, describeFollowThroughError, FollowThroughRecordError } from "./followThrough";

/**
 * P1 Sprint 6 — owner-only mutation route logic for recording actual
 * follow-through on a shadow recommendation. Lives here (not inline in
 * app/api/agents/estimate-closing/recommendations/[eventId]/followthrough/route.ts)
 * for the exact same reason reviewRoute.ts does — see that file's doc
 * comment.
 */

export type FollowThroughRouteDeps = {
  checkAuth?: (request: NextRequest) => Promise<{ authenticated: boolean; response: NextResponse | null }>;
  resolveTenant?: () => Promise<TenantContext | null>;
  recordFollowThrough?: typeof recordEstimateClosingRecommendationFollowThrough;
};

function statusForFollowThroughError(error: FollowThroughRecordError): number {
  switch (error) {
    case "invalid_action_taken":
    case "invalid_action_channel":
    case "invalid_customer_response":
    case "invalid_business_disposition":
    case "invalid_submission_id":
      return 400;
    case "recommendation_not_found":
    case "wrong_event_type":
      // Deliberately the same status for both — same non-enumerating
      // posture as reviewRoute.ts's identical choice.
      return 404;
    default:
      return 400;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function handleFollowThroughRequest(request: NextRequest, eventId: string, deps: FollowThroughRouteDeps = {}): Promise<NextResponse> {
  const doCheckAuth = deps.checkAuth ?? checkAuth;
  const resolveTenant = deps.resolveTenant ?? getTenantContext;
  const recordFollowThrough = deps.recordFollowThrough ?? recordEstimateClosingRecommendationFollowThrough;

  const auth = await doCheckAuth(request);
  if (!auth.authenticated) {
    return auth.response ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenant = await resolveTenant();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  // Owner-only, single call site — matches review.ts/reviewRoute.ts's
  // established convention exactly.
  if (tenant.role !== "owner") {
    return NextResponse.json({ error: "Only the account owner can record Estimate Closing follow-through." }, { status: 403 });
  }

  if (!eventId) {
    return NextResponse.json({ error: "Missing recommendation event id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const result = await recordFollowThrough(tenant.tenantId, tenant.userId, {
    recommendationEventId: eventId,
    actionTaken: isRecord(body) ? body.actionTaken : undefined,
    actionChannel: isRecord(body) ? (body.actionChannel ?? null) : null,
    customerResponse: isRecord(body) ? body.customerResponse : undefined,
    businessDisposition: isRecord(body) ? body.businessDisposition : undefined,
    // Request/transport identity only — see followThrough.ts's
    // buildFollowThroughIdempotencyKey doc comment. Never used for
    // authorization here or downstream; tenant/recommendation ownership is
    // independently verified regardless of this value.
    submissionId: isRecord(body) ? body.submissionId : undefined,
  });

  if (!result.ok) {
    return NextResponse.json({ error: describeFollowThroughError(result.error) }, { status: statusForFollowThroughError(result.error) });
  }

  return NextResponse.json({ followThrough: result.followThrough, occurredAt: result.occurredAt, deduped: result.deduped });
}
