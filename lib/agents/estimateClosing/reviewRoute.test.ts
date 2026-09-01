import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { handleReviewRequest } from "./reviewRoute";
import type { TenantContext } from "@/lib/tenant";

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("https://example.test/api/agents/estimate-closing/recommendations/rec-1/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const AUTHENTICATED = { authenticated: true, response: null };
const UNAUTHENTICATED = { authenticated: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

const OWNER_TENANT: TenantContext = { tenantId: "tenant-1", tenantName: "Test Co", tenantSlug: "test-co", role: "owner", userId: "user-owner" };
const STAFF_TENANT: TenantContext = { tenantId: "tenant-1", tenantName: "Test Co", tenantSlug: "test-co", role: "staff", userId: "user-staff" };

describe("handleReviewRequest", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await handleReviewRequest(makeRequest({ verdict: "agree", wouldAct: "yes", reasonCodes: [] }), "rec-1", {
      checkAuth: async () => UNAUTHENTICATED,
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when no tenant membership resolves", async () => {
    const res = await handleReviewRequest(makeRequest({ verdict: "agree", wouldAct: "yes", reasonCodes: [] }), "rec-1", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => null,
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller is staff, not owner — staff can never review", async () => {
    const recordReview = vi.fn();
    const res = await handleReviewRequest(makeRequest({ verdict: "agree", wouldAct: "yes", reasonCodes: [] }), "rec-1", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => STAFF_TENANT,
      recordReview,
    });
    expect(res.status).toBe(403);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("https://example.test/api/agents/estimate-closing/recommendations/rec-1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    const res = await handleReviewRequest(req, "rec-1", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
    });
    expect(res.status).toBe(400);
  });

  it("calls recordReview with the resolved owner's tenant/user and the URL's eventId — never a body-supplied tenant/id", async () => {
    const recordReview = vi.fn(async () => ({
      ok: true as const,
      review: { recommendationEventId: "rec-1", agentRunId: null, verdict: "agree" as const, wouldAct: "yes" as const, reasonCodes: [] },
      alreadyReviewed: false,
    }));

    const res = await handleReviewRequest(
      makeRequest({ verdict: "agree", wouldAct: "yes", reasonCodes: [], tenantId: "attacker-tenant", recommendationEventId: "attacker-supplied-id" }),
      "rec-1",
      { checkAuth: async () => AUTHENTICATED, resolveTenant: async () => OWNER_TENANT, recordReview }
    );

    expect(res.status).toBe(200);
    expect(recordReview).toHaveBeenCalledWith("tenant-1", "user-owner", {
      recommendationEventId: "rec-1",
      verdict: "agree",
      wouldAct: "yes",
      reasonCodes: [],
    });
  });

  it("maps each review error to its correct HTTP status", async () => {
    const cases: Array<[string, number]> = [
      ["invalid_verdict", 400],
      ["invalid_would_act", 400],
      ["invalid_reason_codes", 400],
      ["recommendation_not_found", 404],
      ["wrong_event_type", 404],
    ];
    for (const [error, expectedStatus] of cases) {
      const res = await handleReviewRequest(makeRequest({ verdict: "agree", wouldAct: "yes", reasonCodes: [] }), "rec-1", {
        checkAuth: async () => AUTHENTICATED,
        resolveTenant: async () => OWNER_TENANT,
        recordReview: async () => ({ ok: false, error: error as never }),
      });
      expect(res.status).toBe(expectedStatus);
    }
  });

  it("returns 200 with the review and alreadyReviewed flag on success", async () => {
    const res = await handleReviewRequest(makeRequest({ verdict: "disagree", wouldAct: "no", reasonCodes: ["timing_wrong"] }), "rec-1", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
      recordReview: async () => ({
        ok: true,
        review: { recommendationEventId: "rec-1", agentRunId: "run-1", verdict: "disagree", wouldAct: "no", reasonCodes: ["timing_wrong"] },
        alreadyReviewed: true,
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.alreadyReviewed).toBe(true);
    expect(json.review.verdict).toBe("disagree");
  });

  it("returns 400 when eventId is empty", async () => {
    const res = await handleReviewRequest(makeRequest({ verdict: "agree", wouldAct: "yes", reasonCodes: [] }), "", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
    });
    expect(res.status).toBe(400);
  });
});
