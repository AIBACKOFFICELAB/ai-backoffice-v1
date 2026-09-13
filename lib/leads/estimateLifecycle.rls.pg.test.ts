import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { getPgTestPool, getPgTestUrl, insertLead, insertMembership, insertTenant } from "@/lib/testHarness/pgTestDb";
import { pgSupabaseAdapter } from "@/lib/testHarness/pgSupabaseAdapter";

const actor = vi.hoisted(() => ({ tenantId: "", tenantName: "Synthetic", userId: "", authorized: true }));
const faults = vi.hoisted(() => ({ sequence: false, event: false, history: false }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-auth", () => ({ checkAuth: async () => actor.authorized ? { authenticated: true } : { authenticated: false, response: new Response(null, { status: 401 }) } }));
vi.mock("@/lib/tenant", () => ({ getTenantContext: async () => actor.authorized ? actor : null }));
vi.mock("@/lib/leads/googleSheets", () => ({ fetchGoogleSheetLeads: async () => [] }));
vi.mock("@/lib/sms/twilio", () => ({ sendSms: vi.fn(async () => ({ ok: true, sid: "synthetic-no-send" })) }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: async () => pgSupabaseAdapter((sql, params) => roleQuery(sql, params, "authenticated")) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => pgSupabaseAdapter((sql, params) => roleQuery(sql, params, "service_role")) }));

import { PUT } from "@/app/api/leads/[id]/route";
import { emitEstimateSentEvent } from "./estimateLifecycleEvent.server";
import { processDueFollowups, recordReplyForPhone } from "@/lib/modules/estimateFollowup/service";
import { sendSms } from "@/lib/sms/twilio";

// The production API, service and event store execute real SQL, with each request
// using exactly the PostgREST role boundary: owner JWT vs private service role.
async function roleQuery(sql: string, params: unknown[], role: "authenticated" | "service_role") {
  const c = await getPgTestPool().connect();
  try {
    await c.query("BEGIN");
    const denied = (faults.sequence && sql.startsWith('INSERT INTO public."estimate_followup_sequences"')) ||
      (faults.history && sql.startsWith('INSERT INTO public."estimate_followup_history"')) ||
      (faults.event && sql.startsWith('INSERT INTO public."business_events"'));
    await c.query(`SET LOCAL ROLE ${denied ? "anon" : role}`);
    await c.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor.userId })]);
    const result = await c.query(sql, params);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally { c.release(); }
}

const DESCRIBE = getPgTestUrl() ? describe : describe.skip;
let leadId: string;
let otherLead: string;
let otherTenant: string;
const retry = (id = leadId) => PUT(new NextRequest(`https://example.test/api/leads/${id}`, {
  method: "PUT", body: JSON.stringify({ status: "Estimate Sent", estimateAmount: 50 }),
}), { params: Promise.resolve({ id }) });
const rows = (table: string) => getPgTestPool().query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [actor.tenantId]);
const historyInsert = (tenantId: string, seq: string, id: string) => roleQuery(
  "INSERT INTO estimate_followup_history(tenant_id,sequence_id,lead_id,event_type) VALUES ($1,$2,$3,'reply_detected')",
  [tenantId, seq, id], "authenticated");
const sequenceInsert = (tenantId: string, id: string) => roleQuery(
  "INSERT INTO estimate_followup_sequences(tenant_id,lead_id,estimate_sent_at,day1_due_at,day3_due_at,day7_due_at) VALUES ($1,$2,now(),now()+interval '1 day',now()+interval '3 days',now()+interval '7 days')",
  [tenantId, id], "authenticated");

DESCRIBE("Estimate Sent real authenticated/RLS lifecycle", () => {
  beforeEach(async () => {
    actor.authorized = true; actor.userId = randomUUID();
    faults.sequence = false; faults.event = false; faults.history = false;
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-never-transmitted");
    const c = await getPgTestPool().connect();
    try {
      actor.tenantId = await insertTenant(c);
      otherTenant = await insertTenant(c);
      await insertMembership(c, actor.tenantId, actor.userId);
      leadId = await insertLead(c, actor.tenantId, { status: "New", estimateAmount: 0 });
      otherLead = await insertLead(c, otherTenant, { status: "Estimate Sent" });
      await c.query("UPDATE leads SET source='website_form', source_ref=$1, intake_schema_version=1, received_at=now() WHERE id=$2", [randomUUID(), leadId]);
      await c.query("INSERT INTO estimate_followup_settings(tenant_id,enabled) VALUES ($1,true)", [actor.tenantId]);
    } finally { c.release(); }
    vi.mocked(sendSms).mockClear();
  });
  afterEach(async () => {
    await getPgTestPool().query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[actor.tenantId, otherTenant]]);
    await getPgTestPool().query("DELETE FROM auth.users WHERE id=$1", [actor.userId]);
    vi.unstubAllEnvs();
  });

  it("authenticated Intake v2 New -> Estimate Sent creates one sequence/event and no governance work", async () => {
    const r = await retry(); expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ leadPersisted: true, estimateLifecycleComplete: true, estimateLifecycle: { outcome: "newly_sent_enrolled" } });
    expect((await rows("estimate_followup_sequences")).rows).toHaveLength(1);
    expect((await rows("business_events")).rows).toHaveLength(1);
    for (const table of ["agent_runs","model_invocations","tool_calls","approvals","outcomes"]) expect((await rows(table)).rows).toHaveLength(0);
    expect(sendSms).not.toHaveBeenCalled();
  });
  it("already Estimate Sent without sequence reconciles at recovery time", async () => {
    await getPgTestPool().query("UPDATE leads SET status='Estimate Sent',estimate_amount=50 WHERE id=$1", [leadId]);
    const before = Date.now(); const r = await retry();
    expect(await r.json()).toMatchObject({ estimateLifecycle: { outcome: "already_sent_reconciled" } });
    const seq = (await rows("estimate_followup_sequences")).rows[0];
    expect(new Date(seq.estimate_sent_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(seq.day1_due_at).getTime() - new Date(seq.estimate_sent_at).getTime()).toBe(86400000);
    expect((await rows("business_events")).rows).toHaveLength(1);
  });
  it("existing sequence and event are unchanged by repeat save", async () => {
    await retry(); const seq = (await rows("estimate_followup_sequences")).rows;
    const event = (await rows("business_events")).rows;
    expect((await retry()).status).toBe(200);
    expect((await rows("estimate_followup_sequences")).rows).toEqual(seq);
    expect((await rows("business_events")).rows).toEqual(event);
  });
  it("four concurrent retries produce exactly one sequence/event", async () => {
    await getPgTestPool().query("UPDATE leads SET status='Estimate Sent',estimate_amount=50 WHERE id=$1", [leadId]);
    const result = await Promise.all([retry(),retry(),retry(),retry()]);
    expect(result.map(r=>r.status)).toEqual([200,200,200,200]);
    expect((await rows("estimate_followup_sequences")).rows).toHaveLength(1);
    expect((await rows("business_events")).rows).toHaveLength(1);
  });
  it("real RLS insert failure preserves lead but returns incomplete; retry repairs", async () => {
    faults.sequence = true;
    const r = await retry(); expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ leadPersisted: true, estimateLifecycleComplete: false, lead: { status: "Estimate Sent" } });
    expect((await rows("estimate_followup_sequences")).rows).toHaveLength(0);
    expect((await rows("business_events")).rows).toHaveLength(0);
    faults.sequence = false; expect((await retry()).status).toBe(200);
  });
  it("real event RLS failure returns incomplete; retry repairs event without another sequence", async () => {
    faults.event = true;
    const r = await retry(); expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ leadPersisted: true, estimateLifecycleComplete: false, estimateLifecycle: { outcome: "event_failed" } });
    expect((await rows("estimate_followup_sequences")).rows).toHaveLength(1);
    expect((await rows("business_events")).rows).toHaveLength(0);
    faults.event = false; expect((await retry()).status).toBe(200);
    expect((await rows("estimate_followup_sequences")).rows).toHaveLength(1);
    expect((await rows("business_events")).rows).toHaveLength(1);
  });
  it("refuses cross-tenant API updates and unauthenticated callers", async () => {
    expect((await retry(otherLead)).status).toBe(404);
    actor.authorized = false; expect((await retry()).status).toBe(401);
  });
  it("denies cross-tenant sequence inserts and mismatched lead references", async () => {
    await expect(sequenceInsert(otherTenant, otherLead)).rejects.toMatchObject({ code: "42501" });
    await expect(sequenceInsert(actor.tenantId, otherLead)).rejects.toMatchObject({ code: "42501" });
  });
  it("denies tenant reassignment and cross-tenant sequence updates", async () => {
    await retry(); const seq = (await rows("estimate_followup_sequences")).rows[0];
    await expect(roleQuery("UPDATE estimate_followup_sequences SET tenant_id=$1 WHERE id=$2", [otherTenant,seq.id], "authenticated")).rejects.toMatchObject({ code:"42501" });
    await getPgTestPool().query("INSERT INTO estimate_followup_sequences(tenant_id,lead_id,estimate_sent_at,day1_due_at,day3_due_at,day7_due_at) VALUES ($1,$2,now(),now(),now(),now())", [otherTenant,otherLead]);
    const result = await roleQuery("UPDATE estimate_followup_sequences SET status='stopped' WHERE tenant_id=$1", [otherTenant], "authenticated");
    expect(result.rowCount).toBe(0);
    expect((await getPgTestPool().query("SELECT status FROM estimate_followup_sequences WHERE tenant_id=$1",[otherTenant])).rows[0].status).toBe("active");
  });
  it("history INSERT requires matching tenant, sequence and lead", async () => {
    await retry(); const seq = (await rows("estimate_followup_sequences")).rows[0];
    await expect(historyInsert(otherTenant, seq.id, leadId)).rejects.toMatchObject({ code:"42501" });
    await expect(historyInsert(actor.tenantId,seq.id,otherLead)).rejects.toMatchObject({ code:"42501" });
    await expect(historyInsert(actor.tenantId,seq.id,leadId)).resolves.toMatchObject({rowCount:1});
  });
  it("Day 1 authenticated processing persists update and history; fake SMS only", async () => {
    await retry();
    await getPgTestPool().query("UPDATE estimate_followup_sequences SET day1_due_at=now()-interval '1 minute' WHERE tenant_id=$1", [actor.tenantId]);
    const result = await processDueFollowups();
    expect(result).toEqual([{ leadId,action:"day1",sent:true }]);
    expect((await rows("estimate_followup_sequences")).rows[0].day1_sent_at).not.toBeNull();
    expect((await rows("estimate_followup_history")).rows[0].event_type).toBe("day1_sent");
    expect(sendSms).toHaveBeenCalledTimes(1);
  });
  it("cookie-free cron service role retains sequence UPDATE and history INSERT privileges", async () => {
    await retry(); const seq = (await rows("estimate_followup_sequences")).rows[0];
    await roleQuery("UPDATE estimate_followup_sequences SET day1_sent_at=now() WHERE tenant_id=$1 AND id=$2", [actor.tenantId,seq.id], "service_role");
    await roleQuery("INSERT INTO estimate_followup_history(tenant_id,sequence_id,lead_id,event_type) VALUES ($1,$2,$3,'day1_sent')", [actor.tenantId,seq.id,leadId], "service_role");
    expect((await rows("estimate_followup_sequences")).rows[0].day1_sent_at).not.toBeNull();
    expect((await rows("estimate_followup_history")).rows[0].event_type).toBe("day1_sent");
  });
  it("reply handling persists stop and history under authenticated RLS", async () => {
    await retry();
    expect(await recordReplyForPhone(actor.tenantId, "555-0100")).toMatchObject({matched:true,stopped:true});
    expect((await rows("estimate_followup_sequences")).rows[0].status).toBe("replied");
    expect((await rows("estimate_followup_history")).rows[0].event_type).toBe("reply_detected");
    expect(sendSms).not.toHaveBeenCalled();
  });
  it("history failure is surfaced rather than reporting successful reply handling", async () => {
    await retry(); faults.history = true;
    await expect(recordReplyForPhone(actor.tenantId,"555-0100")).rejects.toThrow("Follow-up history insert failed");
  });
  it("authenticated clients still cannot write arbitrary business events or delete sequences", async () => {
    await retry();
    await expect(roleQuery("INSERT INTO business_events(tenant_id,event_type) VALUES ($1,'estimate.sent')",[actor.tenantId],"authenticated")).rejects.toMatchObject({code:"42501"});
    expect((await roleQuery("DELETE FROM estimate_followup_sequences WHERE tenant_id=$1",[actor.tenantId],"authenticated")).rowCount).toBe(0);
  });
  it("private event operation rejects forged tenant/actor and absent lifecycle facts", async () => {
    const base = {tenantId:actor.tenantId,leadId,estimateAmount:50,sequenceCreated:false,actorUserId:actor.userId};
    await expect(emitEstimateSentEvent({...base,tenantId:otherTenant})).rejects.toThrow("authorization");
    await expect(emitEstimateSentEvent({...base,actorUserId:randomUUID()})).rejects.toThrow("authorization");
    await expect(emitEstimateSentEvent(base)).rejects.toThrow("facts unavailable");
    expect((await rows("business_events")).rows).toHaveLength(0);
  });
  it("migration reapplication leaves records unchanged", async () => {
    await retry(); const before=(await rows("estimate_followup_sequences")).rows;
    await getPgTestPool().query(readFileSync("db/migrations/024_estimate_followup_lifecycle_write_policies.sql","utf8"));
    expect((await rows("estimate_followup_sequences")).rows).toEqual(before);
  });
});
afterAll(async()=> { if(getPgTestUrl()) await getPgTestPool().end(); });
