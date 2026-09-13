import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
vi.mock("server-only", () => ({}));
import { resolvePublicIntakeTenant } from "./server";
import { emitEvent } from "@/lib/events/service";
import { InMemoryBusinessEventStore } from "@/lib/events/store";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("elevated intake boundary", () => {
  it("the real Supabase client uses service credentials and filters active slug without visitor cookies", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "private-test-key");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "tenant", name: "Business", email: null }), { headers: { "Content-Type": "application/json" } }));
    expect(await resolvePublicIntakeTenant("test-business")).toEqual({ id: "tenant", name: "Business", email: null });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain("slug=eq.test-business"); expect(String(url)).toContain("status=eq.active");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-test-key");
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
  });
  it("malformed slugs never access the DB", async () => {
    const fetch = vi.spyOn(globalThis, "fetch"); expect(await resolvePublicIntakeTenant("../other")).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it("client form imports validation only; credential adapter has a server-only build guard", () => {
    const form = readFileSync("components/LeadIntakeForm.tsx", "utf8"); expect(form).not.toMatch(/intake\/(server|service)|SUPABASE_SERVICE_ROLE_KEY/);
    expect(readFileSync("lib/leads/intake/server.ts", "utf8")).toContain('import "server-only"');
  });
  it("intake domain imports no execution/governance writers", () => {
    const service = readFileSync("lib/leads/intake/service.ts", "utf8");
    expect(service).not.toMatch(/from ["'][^"']*(agents|approvals|outcomes|ai\/|estimateLifecycle|modules)[^"']*["']/);
  });
  it("lead-created contract rejects raw customer fields while retaining MCR compatibility", async () => {
    const store = new InMemoryBusinessEventStore();
    await expect(emitEvent({ tenantId: "test", eventType: "lead.created", payload: { phone: "private" } }, store)).rejects.toThrow();
    await expect(emitEvent({ tenantId: "test", eventType: "lead.created", payload: { source: "missed-call-recovery", status: "New" } }, store)).resolves.toBeDefined();
  });
});
