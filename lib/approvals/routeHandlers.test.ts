import { describe, it, expect, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { handleApprovalDecision } from "./routeHandlers";
import type { TenantContext } from "@/lib/tenant";
import type { Approval } from "./types";

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("https://example.test/api/approvals/approval-1/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const AUTHENTICATED = { authenticated: true, response: null };
const UNAUTHENTICATED = { authenticated: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
const OWNER_TENANT: TenantContext = { tenantId: "tenant-1", tenantName: "Test Co", tenantSlug: "test-co", role: "owner", userId: "user-owner" };

function fakeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    tenantId: "tenant-1",
    agentId: "agent-1",
    agentRunId: "run-1",
    requestedAction: "draft_customer_message.execute",
    payload: {},
    riskLevel: "medium",
    status: "approved",
    requestedByType: "agent",
    requestedById: "agent-1",
    approverUserId: "user-owner",
    reason: null,
    payloadDigest: "sha256:abc",
    approvedAt: new Date().toISOString(),
    rejectedAt: null,
    expiresAt: null,
    executionResult: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("handleApprovalDecision", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await handleApprovalDecision(makeRequest(), "approval-1", "approve", { checkAuth: async () => UNAUTHENTICATED });
    expect(res.status).toBe(401);
  });

  it("returns 403 when no tenant resolves", async () => {
    const res = await handleApprovalDecision(makeRequest(), "approval-1", "approve", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => null,
    });
    expect(res.status).toBe(403);
  });

  it("calls approve with the resolved tenant id and the URL's approval id (never body-supplied)", async () => {
    const approve = vi.fn(async () => fakeApproval());
    const res = await handleApprovalDecision(makeRequest({ tenantId: "attacker-tenant", approvalId: "attacker-id" }), "approval-1", "approve", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
      approve,
    });
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledWith("tenant-1", "approval-1");
  });

  it("calls reject with an optional reason from the body", async () => {
    const reject = vi.fn(async () => fakeApproval({ status: "rejected" }));
    const res = await handleApprovalDecision(makeRequest({ reason: "not the right time" }), "approval-1", "reject", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
      reject,
    });
    expect(res.status).toBe(200);
    expect(reject).toHaveBeenCalledWith("tenant-1", "approval-1", "not the right time");
  });

  it("maps a role-denial error message to 403 — staff can never approve/reject", async () => {
    const approve = vi.fn(async () => {
      throw new Error("only a tenant owner may approve an agent action");
    });
    const res = await handleApprovalDecision(makeRequest(), "approval-1", "approve", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
      approve,
    });
    expect(res.status).toBe(403);
  });

  it("maps a not-found error to 404 — a cross-tenant approval id is inaccessible", async () => {
    const approve = vi.fn(async () => {
      throw new Error("approval approval-1 not found");
    });
    const res = await handleApprovalDecision(makeRequest(), "approval-1", "approve", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
      approve,
    });
    expect(res.status).toBe(404);
  });

  it("maps an expired/already-decided CAS failure to 409", async () => {
    const approve = vi.fn(async () => {
      throw new Error("approval approval-1 has expired");
    });
    const res = await handleApprovalDecision(makeRequest(), "approval-1", "approve", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
      approve,
    });
    expect(res.status).toBe(409);

    const alreadyDecided = vi.fn(async () => {
      throw new Error("approval approval-1 is 'rejected', not 'pending' — cannot approve");
    });
    const res2 = await handleApprovalDecision(makeRequest(), "approval-1", "approve", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
      approve: alreadyDecided,
    });
    expect(res2.status).toBe(409);
  });

  it("returns 200 with the decided approval on success", async () => {
    const res = await handleApprovalDecision(makeRequest(), "approval-1", "approve", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
      approve: async () => fakeApproval({ status: "approved" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.approval.status).toBe("approved");
  });

  it("is a pure passthrough of whatever the service layer returns — adds no new exposure surface of its own", async () => {
    // The UI-layer redaction obligation (P1 Sprint 3 §11: "show only the
    // existing safe summary/digest representation") belongs to the
    // Approval Center page/card component, not this route — this route
    // just relays the already-existing Approval record; it invents no new
    // field and strips none. Pinned here so a future edit that starts
    // enriching this response gets caught.
    const approval = fakeApproval({ payload: { toolName: "draft_customer_message" } });
    const res = await handleApprovalDecision(makeRequest(), "approval-1", "approve", {
      checkAuth: async () => AUTHENTICATED,
      resolveTenant: async () => OWNER_TENANT,
      approve: async () => approval,
    });
    const json = await res.json();
    expect(Object.keys(json)).toEqual(["approval"]);
    expect(json.approval).toEqual(approval);
  });
});
