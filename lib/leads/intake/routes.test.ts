import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { testIntake } from "./fixtures";
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), create: vi.fn(), auth: vi.fn(), context: vi.fn(), profile: vi.fn() }));
vi.mock("./server", () => ({ resolvePublicIntakeTenant: mocks.resolve, createLiveIntakeDeps: () => ({}) }));
vi.mock("./service", () => ({ createCanonicalLeadFromIntake: mocks.create }));
vi.mock("@/lib/api-auth", () => ({ checkAuth: mocks.auth }));
vi.mock("@/lib/tenant", () => ({ getTenantContext: mocks.context, getTenantProfile: mocks.profile }));
import { POST as publicPost } from "@/app/api/request/[slug]/route";
import { POST as manualPost } from "@/app/api/leads/route";
const request = (body: unknown = testIntake) => new NextRequest("https://example.test/api/request/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); mocks.resolve.mockResolvedValue({ id: "server-tenant", name: "Test", email: null });
  mocks.create.mockResolvedValue({ lead: { id: "canonical" }, deduped: false }); mocks.auth.mockResolvedValue({ authenticated: true });
  mocks.context.mockResolvedValue({ tenantId: "member-tenant", tenantName: "Test", userId: "verified-user" }); mocks.profile.mockResolvedValue({ email: null });
});
describe("intake routes", () => {
  it("uses server slug resolution without login and exposes no lead or tenant data", async () => {
    const r = await publicPost(request(), { params: Promise.resolve({ slug: "test-business" }) });
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ accepted: true }); expect(mocks.resolve).toHaveBeenCalledWith("test-business");
    expect(mocks.create).toHaveBeenCalledWith(testIntake, expect.objectContaining({ id: "server-tenant" }), "website_form", null, {});
    expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("unknown tenant returns safe 404 without creation", async () => {
    mocks.resolve.mockResolvedValue(null); const r = await publicPost(request(), { params: Promise.resolve({ slug: "missing" }) }); expect(r.status).toBe(404); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("browser tenant_id fails before tenant lookup", async () => {
    const r = await publicPost(request({ ...testIntake, tenant_id: "forged" }), { params: Promise.resolve({ slug: "test" }) }); expect(r.status).toBe(400); expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("database failures do not expose internals", async () => {
    mocks.resolve.mockRejectedValue(new Error("secret SQL stack")); const r = await publicPost(request(), { params: Promise.resolve({ slug: "test" }) }); expect(r.status).toBe(503); expect(await r.text()).not.toContain("secret");
  });
  it("manual route rejects unauthenticated callers", async () => {
    mocks.auth.mockResolvedValue({ authenticated: false, response: new Response("Unauthorized", { status: 401 }) }); expect((await manualPost(request())).status).toBe(401); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("manual route requires membership", async () => {
    mocks.context.mockResolvedValue(null); expect((await manualPost(request())).status).toBe(403); expect(mocks.create).not.toHaveBeenCalled();
  });
  it("manual route calls same boundary with verified membership and actor", async () => {
    expect((await manualPost(request())).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(testIntake, { id: "member-tenant", name: "Test", email: null }, "manual", "verified-user", {});
  });
});
