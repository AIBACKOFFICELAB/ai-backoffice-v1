import { NextRequest, NextResponse } from "next/server";
import { checkAuth } from "@/lib/api-auth";
import { getTenantContext, TenantContext } from "@/lib/tenant";
import { recordEstimateClosingRecommendationReview, describeReviewError, ReviewRecordError } from "./review";

/**
 * P1 Sprint 3 — owner-only mutation route logic for reviewing a shadow
 * recommendation. Lives here (not inline in
 * app/api/agents/estimate-closing/recommendations/[eventId]/review/route.ts)
 * for the same reason lib/agents/estimateClosing/scanRoute.ts does: Next's
 * App Router route.ts files may only export a fixed set of names, and
 * keeping the real logic in lib/ with injectable deps is what makes it
 * testable without a live Supabase session — mirrors scanRoute.ts's
 * ScanRouteDeps pattern exactly.
 */

export type ReviewRouteDeps = {
  checkAuth?: (request: NextRequest) => Promise<{ authenticated: boolean; response: NextResponse | null }>;
  resolveTenant?: () => Promise<TenantContext | null>;
  recordReview?: typeof recordEstimateClosingRecommendationReview;
};

function statusForReviewError(error: ReviewRecordError): number {
  switch (error) {
    case "invalid_verdict":
    case "invalid_would_act":
    case "invalid_reason_codes":
      return 400;
    case "recommendation_not_found":
    case "wrong_event_type":
      // Deliberately the same status for both: a caller must not be able
      // to distinguish "this id exists but is the wrong event type" from
      // "this id doesn't exist / belongs to another tenant" — same
      // non-enumerating posture as recordEstimateClosingRecommendationReview
      // itself applies at the store layer.
      return 404;
    default:
      return 400;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function handleReviewRequest(request: NextRequest, eventId: string, deps: ReviewRouteDeps = {}): Promise<NextResponse> {
  const doCheckAuth = deps.checkAuth ?? checkAuth;
  const resolveTenant = deps.resolveTenant ?? getTenantContext;
  const recordReview = deps.recordReview ?? recordEstimateClosingRecommendationReview;

  const auth = await doCheckAuth(request);
  if (!auth.authenticated) {
    return auth.response ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenant = await resolveTenant();
  if (!tenant) {
    return NextResponse.json({ error: "No tenant membership found for this user." }, { status: 403 });
  }

  // Owner-only, single call site — resolved and enforced here directly
  // (matching app/api/tenant/profile/route.ts's convention), not via the
  // approvals-style AsAuthenticatedActor wrapper, which exists there
  // because approve/reject have multiple call sites. See review.ts's own
  // doc comment on recordEstimateClosingRecommendationReview.
  if (tenant.role !== "owner") {
    return NextResponse.json({ error: "Only the account owner can review Estimate Closing recommendations." }, { status: 403 });
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

  const result = await recordReview(tenant.tenantId, tenant.userId, {
    recommendationEventId: eventId,
    verdict: isRecord(body) ? body.verdict : undefined,
    wouldAct: isRecord(body) ? body.wouldAct : undefined,
    reasonCodes: isRecord(body) ? body.reasonCodes : undefined,
  });

  if (!result.ok) {
    return NextResponse.json({ error: describeReviewError(result.error) }, { status: statusForReviewError(result.error) });
  }

  return NextResponse.json({ review: result.review, alreadyReviewed: result.alreadyReviewed });
}
