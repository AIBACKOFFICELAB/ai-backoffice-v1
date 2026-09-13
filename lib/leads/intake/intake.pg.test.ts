import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getPgTestPool, getPgTestUrl, insertTenant, insertLead, withRollback, setRole } from "@/lib/testHarness/pgTestDb";
import { pgSupabaseAdapter } from "@/lib/testHarness/pgSupabaseAdapter";
vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => pgSupabaseAdapter() }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: async () => pgSupabaseAdapter() }));
vi.mock("@/lib/leads/googleSheets", () => ({ fetchGoogleSheetLeads: vi.fn(async () => []) }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn(async () => ({ ok: false, skipped: false, reason: "resend-error" })) }));
const actor = vi.hoisted(() => ({ tenantId: "", tenantName: "Test", userId: "verified-user" }));
vi.mock("@/lib/api-auth", () => ({ checkAuth: async () => ({ authenticated: true }) }));
vi.mock("@/lib/tenant", () => ({ getTenantContext: async () => actor }));
import { createLiveIntakeDeps, resolvePublicIntakeTenant } from "./server";
import { createCanonicalLeadFromIntake } from "./service";
import { testIntake } from "./fixtures";
import { POST } from "@/app/api/request/[slug]/route";
import { PUT } from "@/app/api/leads/[id]/route";
import { getLeadById, getLeads } from "@/lib/leads/repository";
import { NextRequest } from "next/server";
const DESCRIBE = getPgTestUrl() ? describe : describe.skip;
let tenantId: string;
let slug: string;
let extraTenant: string | undefined;
const request = (payload: unknown = testIntake) => new Request("https://example.test/api/request/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
DESCRIBE("canonical intake production service/store/route against real PostgreSQL", () => {
  beforeEach(async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-only-no-network");
    const client = await getPgTestPool().connect();
    try { slug = `intake-${randomUUID()}`; tenantId = await insertTenant(client, { slug }); actor.tenantId = tenantId; }
    finally { client.release(); }
  });
  afterEach(async () => {
    await getPgTestPool().query("DELETE FROM public.tenants WHERE id = ANY($1::uuid[])", [[tenantId, ...(extraTenant ? [extraTenant] : [])]]);
    extraTenant = undefined; vi.unstubAllEnvs();
  });
  it("public submission persists a canonical UUID/provenance and one event, with zero governance side effects", async () => {
    const r = await POST(request(), { params: Promise.resolve({ slug }) }); expect(r.status).toBe(200);
    const rows = await getPgTestPool().query("SELECT * FROM leads WHERE tenant_id=$1", [tenantId]); expect(rows.rows).toHaveLength(1);
    const lead = rows.rows[0]; expect(lead.id).toMatch(/^[0-9a-f-]{36}$/); expect(lead.source_ref).toBe(testIntake.sourceRef); expect(lead.intake_schema_version).toBe(1); expect(lead.received_at).toBeInstanceOf(Date); expect(lead.status).toBe("New"); expect(Number(lead.estimate_amount)).toBe(0);
    const events = await getPgTestPool().query("SELECT * FROM business_events WHERE tenant_id=$1", [tenantId]); expect(events.rows).toHaveLength(1); expect(events.rows[0].event_type).toBe("lead.created"); expect(JSON.stringify(events.rows[0].payload)).not.toContain(testIntake.email);
    for (const table of ["agent_runs", "model_invocations", "tool_calls", "approvals", "outcomes", "estimate_followup_sequences"]) expect((await getPgTestPool().query(`SELECT count(*) FROM ${table} WHERE tenant_id=$1`, [tenantId])).rows[0].count).toBe("0");
  });
  it("ten concurrent identical public submissions persist exactly one lead/event", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => POST(request(), { params: Promise.resolve({ slug }) })));
    expect(results.map(r => r.status)).toEqual(Array(10).fill(200));
    expect((await getPgTestPool().query("SELECT count(*) FROM leads WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe("1");
    expect((await getPgTestPool().query("SELECT count(*) FROM business_events WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe("1");
  });
  it("distinct jobs can share customer data; tenant identity is independently unique", async () => {
    await POST(request(), { params: Promise.resolve({ slug }) }); await POST(request({ ...testIntake, sourceRef: randomUUID() }), { params: Promise.resolve({ slug }) });
    const c = await getPgTestPool().connect(); try { extraTenant = await insertTenant(c); } finally { c.release(); }
    await createCanonicalLeadFromIntake(testIntake, { id: extraTenant, name: "Other", email: null }, "website_form", null, createLiveIntakeDeps());
    expect((await getPgTestPool().query("SELECT count(*) FROM leads WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe("2");
    expect((await getPgTestPool().query("SELECT count(*) FROM leads WHERE tenant_id=$1", [extraTenant])).rows[0].count).toBe("1");
  });
  it("unknown or paused tenant cannot receive a public submission", async () => {
    expect((await POST(request(), { params: Promise.resolve({ slug: "missing" }) })).status).toBe(404);
    await getPgTestPool().query("UPDATE tenants SET status='paused' WHERE id=$1", [tenantId]);
    expect(await resolvePublicIntakeTenant(slug)).toBeNull(); expect((await POST(request(), { params: Promise.resolve({ slug }) })).status).toBe(404);
    expect((await getPgTestPool().query("SELECT count(*) FROM leads WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe("0");
  });
  it("notification failure leaves persisted lead and event intact", async () => {
    const result = await createCanonicalLeadFromIntake(testIntake, { id: tenantId, name: "Test", email: "owner@example.invalid" }, "website_form", null, createLiveIntakeDeps());
    expect((await getLeadById(result.lead.id, tenantId)).lead?.id).toBe(result.lead.id);
  });
  it("existing readers/API and unchanged Estimate Sent transition accept intake leads", async () => {
    const { lead } = await createCanonicalLeadFromIntake(testIntake, { id: tenantId, name: "Test", email: null }, "website_form", null, createLiveIntakeDeps());
    expect((await getLeads(tenantId)).leads.map(l => l.id)).toContain(lead.id); expect((await getLeadById(lead.id, tenantId)).source).toBe("supabase");
    const req = new NextRequest(`https://example.test/api/leads/${lead.id}`, { method: "PUT", body: JSON.stringify({ status: "Estimate Sent", estimateAmount: 250 }) });
    const r = await PUT(req, { params: Promise.resolve({ id: lead.id }) }); expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ lead: { id: lead.id, status: "Estimate Sent", estimateAmount: 250 }, estimateLifecycle: { outcome: "newly_sent_enrolled" } });
    const seq = await getPgTestPool().query("SELECT * FROM estimate_followup_sequences WHERE tenant_id=$1 AND lead_id=$2", [tenantId, lead.id]); expect(seq.rows).toHaveLength(1);
    const events = await getPgTestPool().query("SELECT event_type FROM business_events WHERE tenant_id=$1 ORDER BY event_type", [tenantId]); expect(events.rows.map(r => r.event_type)).toEqual(["estimate.sent", "lead.created"]);
  });
  it("legacy GS operational writes are refused before database mutation", async () => {
    const req = new NextRequest("https://example.test/api/leads/GS-1", { method: "PUT", body: JSON.stringify({ status: "Estimate Sent", estimateAmount: 250 }) });
    expect((await PUT(req, { params: Promise.resolve({ id: "GS-1" }) })).status).toBe(409);
    expect((await getPgTestPool().query("SELECT count(*) FROM leads WHERE tenant_id=$1", [tenantId])).rows[0].count).toBe("0");
  });
  it("migration is repeatable and does not rewrite existing lead rows", async () => {
    const c = await getPgTestPool().connect(); let id: string;
    try { id = await insertLead(c, tenantId); } finally { c.release(); }
    const before = (await getPgTestPool().query("SELECT * FROM leads WHERE id=$1", [id])).rows[0];
    await getPgTestPool().query(readFileSync("db/migrations/023_canonical_lead_intake_provenance.sql", "utf8"));
    expect((await getPgTestPool().query("SELECT * FROM leads WHERE id=$1", [id])).rows[0]).toEqual(before);
    expect(before.source_ref).toBeNull();
  });
  it("RLS still denies anonymous writes to canonical leads", async () => {
    await withRollback(async c => {
      await setRole(c, "anon");
      await expect(insertLead(c, tenantId)).rejects.toMatchObject({ code: "42501" });
    });
  });
});
afterAll(async () => { if (getPgTestUrl()) await getPgTestPool().end(); });
