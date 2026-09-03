import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { handleFollowThroughRequest } from "./followThroughRoute";
import type { TenantContext } from "@/lib/tenant";

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("https://example.test/api/agents/estimate-closing/recommendations/rec-1/followthrough", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const AUTHENTICATED = { authenticated: true, response: null };
const UNAUTHENTICATED = { authenticated: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

const OWNER_TENANT: TenantContext = { tenantId: "tenant-1", tenantName: "Test Co", tenantSlug: "test-co", role: "owner", userId: "user-owner" };
const STAFF_TENANT: TenantContext = { tenantId: "tenant-1", tenantName: "Test Co", tenantSlug: "test-co", role: "staff", userId: "user-staff" };

const VALID_BODY = { actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" };

describe("handleFollowThroughRequest", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await handleFollowThroughRequest(makeRequest(VALID_BODY), "rec-1", { checkAuth: async () => UNAUTHENTICATED });
    expect(res.status).toBe(401);
  });

  it("returns 403 when no tenant membership resolves", async () => {
    const res = await handleFollowThroughRequest(makeRequest(VALID_BODY), "rec-1", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => null,
    });
    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller is staff, not owner — staff can never record follow-through", async () => {
    const recordFollowThrough = vi.fn();
    const res = await handleFollowThroughRequest(makeRequest(VALID_BODY), "rec-1", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => STAFF_TENANT,
      recordFollowThrough,
    });
    expect(res.status).toBe(403);
    expect(recordFollowThrough).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const req = new NextRequest("https://example.test/api/agents/estimate-closing/recommendations/rec-1/followthrough", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    const res = await handleFollowThroughRequest(req, "rec-1", { checkAuth: async () => AUTHENTICATED, resolveTenant: async () => OWNER_TENANT });
    expect(res.status).toBe(400);
  });

  it("calls recordFollowThrough with the resolved owner's tenant/user and the URL's eventId — never a body-supplied tenant/id", async () => {
    const recordFollowThrough = vi.fn(async () => ({
      ok: true as const,
      followThrough: { recommendationEventId: "rec-1", actionTaken: "yes" as const, actionChannel: "phone" as const, customerResponse: "observed" as const, businessDisposition: "won" as const },
      occurredAt: "2026-01-01T00:00:00.000Z",
      deduped: false,
    }));

    const res = await handleFollowThroughRequest(
      makeRequest({ ...VALID_BODY, tenantId: "attacker-tenant", recommendationEventId: "attacker-supplied-id" }),
      "rec-1",
      { checkAuth: async () => AUTHENTICATED, resolveTenant: async () => OWNER_TENANT, recordFollowThrough }
    );

    expect(res.status).toBe(200);
    expect(recordFollowThrough).toHaveBeenCalledWith("tenant-1", "user-owner", {
      recommendationEventId: "rec-1",
      actionTaken: "yes",
      actionChannel: "phone",
      customerResponse: "observed",
      businessDisposition: "won",
    });
  });

  it("passes actionChannel as null when omitted (actionTaken 'no'/'later' case)", async () => {
    const recordFollowThrough = vi.fn(async () => ({
      ok: true as const,
      followThrough: { recommendationEventId: "rec-1", actionTaken: "no" as const, actionChannel: null, customerResponse: "unknown" as const, businessDisposition: "pending" as const },
      occurredAt: "2026-01-01T00:00:00.000Z",
      deduped: false,
    }));

    await handleFollowThroughRequest(makeRequest({ actionTaken: "no", customerResponse: "unknown", businessDisposition: "pending" }), "rec-1", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
      recordFollowThrough,
    });

    expect(recordFollowThrough).toHaveBeenCalledWith("tenant-1", "user-owner", {
      recommendationEventId: "rec-1",
      actionTaken: "no",
      actionChannel: null,
      customerResponse: "unknown",
      businessDisposition: "pending",
    });
  });

  it("maps each follow-through error to its correct HTTP status", async () => {
    const cases: Array<[string, number]> = [
      ["invalid_action_taken", 400],
      ["invalid_action_channel", 400],
      ["invalid_customer_response", 400],
      ["invalid_business_disposition", 400],
      ["recommendation_not_found", 404],
      ["wrong_event_type", 404],
    ];
    for (const [error, expectedStatus] of cases) {
      const res = await handleFollowThroughRequest(makeRequest(VALID_BODY), "rec-1", {
        checkAuth: async () => AUTHENTICATED,
        resolveTenant: async () => OWNER_TENANT,
        recordFollowThrough: async () => ({ ok: false, error: error as never }),
      });
      expect(res.status).toBe(expectedStatus);
    }
  });

  it("returns 200 with the follow-through and deduped flag on success", async () => {
    const res = await handleFollowThroughRequest(makeRequest(VALID_BODY), "rec-1", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
      recordFollowThrough: async () => ({
        ok: true,
        followThrough: { recommendationEventId: "rec-1", actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" },
        occurredAt: "2026-01-01T00:00:00.000Z",
        deduped: true,
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deduped).toBe(true);
    expect(json.followThrough.businessDisposition).toBe("won");
  });

  it("returns 400 when eventId is empty", async () => {
    const res = await handleFollowThroughRequest(makeRequest(VALID_BODY), "", { checkAuth: async () => AUTHENTICATED, resolveTenant: async () => OWNER_TENANT });
    expect(res.status).toBe(400);
  });
});
