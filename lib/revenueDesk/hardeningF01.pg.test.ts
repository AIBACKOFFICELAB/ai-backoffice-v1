import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getPgTestUrl } from "../testHarness/pgTestDb";
import { completeCall, recordTransferInitiated, transferDestination, type CallPatch, type RevenueDeskDeps } from "./service";
import { transferEvidenceLabel, transferLabel, transferOutcome } from "./transfer";

// A real 027 -> 028 upgrade, not a fresh-schema approximation. Only a local
// disposable PostgreSQL server is permitted; no hosted URL can create a DB.
// Deliberately retains the canonical historical profile for legacy backfill
// regressions. Final H001 security acceptance uses the separate Preview
// SEC-01 profile (npm run test:db:bootstrap), checked by previewProfile.pg.test.ts.
const url = getPgTestUrl();
const suite = url ? describe : describe.skip;
const database = `rd_f01_${randomUUID().replaceAll("-", "")}`;
let admin: Client;
let pool: Pool;
let created = false;
let tenant: string;
const historical = new Map<string, string>();
const cases = [
  ["forwarded", "assistant-forwarded-call", "transferred", "booked", "transferred"],
  ["failed", "call.in-progress.error-transfer-failed", "transfer_failed", "escalated", "transfer_failed"],
  ["interrupted", "customer-ended-call-during-transfer", "transferred", "completed", "unknown"],
  ["unsupported-success", "transfer-super-success", "transferred", "completed", "unknown"],
  ["unsupported-failure", null, "transfer_failed", "escalated", "unknown"],
  ["ordinary", "customer-ended-call", null, "completed", null],
  ["timestamp-only", null, null, "booked", null],
  ["status-only", null, null, "failed", null],
] as const;

suite("F01 historical transfer upgrade and real application/DB agreement", () => {
  beforeAll(async () => {
    const source = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(source.hostname)) throw new Error("F01 upgrade test requires disposable localhost PostgreSQL");
    admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`); created = true;
    source.pathname = `/${database}`;
    pool = new Pool({ connectionString: source.toString() });
    await pool.query(readFileSync(join(process.cwd(), "db/shadow_env/000_supabase_scaffold.sql"), "utf8"));
    const migrations = join(process.cwd(), "db/migrations");
    for (const file of readdirSync(migrations).filter(f => /^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= 27).sort()) {
      await pool.query(readFileSync(join(migrations, file), "utf8"));
    }
    tenant = (await pool.query(`INSERT INTO tenants(name,slug) VALUES('F01 synthetic',$1) RETURNING id`, [randomUUID()])).rows[0].id;
    for (const [name, reason, outcome, status] of cases) {
      const id = (await pool.query(`INSERT INTO revenue_desk_calls(tenant_id,provider_call_id,status,ended_reason,escalation_result,ended_at)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [tenant,name,status,reason,outcome,name === "timestamp-only" ? new Date() : null])).rows[0].id;
      historical.set(name,id);
    }
    await pool.query(readFileSync(join(migrations,"028_revenue_desk_hardening.sql"),"utf8"));
  }, 30000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      if (created) await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  });

  async function transaction(fn: (c: PoolClient) => Promise<void>) {
    const c = await pool.connect();
    try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE service_role"); await fn(c); }
    finally { await c.query("ROLLBACK"); c.release(); }
  }
  async function fresh(c: PoolClient) {
    return (await c.query(`INSERT INTO revenue_desk_calls(tenant_id,provider_call_id) VALUES($1,$2) RETURNING id`, [tenant,randomUUID()])).rows[0].id as string;
  }
  async function state(c: PoolClient, id: string) {
    return (await c.query(`SELECT escalation_result,transfer_final,transfer_evidence FROM revenue_desk_calls WHERE tenant_id=$1 AND id=$2`,[tenant,id])).rows[0];
  }
  function app(c: PoolClient, id: string) {
    // Execute actual application transition functions; persist their patches
    // as the service role against the actual trigger, not a state-machine fake.
    const columns: Record<string,string> = { status:"status",endedReason:"ended_reason",escalationResult:"escalation_result",transferFinal:"transfer_final",failureCategory:"failure_category" };
    const deps = { store: {
      updateCall: async (t: string, callId: string, patch: CallPatch) => {
        const entries=Object.entries(patch);
        if(entries.some(([key])=>!columns[key])) throw new Error("test adapter missing column");
        await c.query(`UPDATE revenue_desk_calls SET ${entries.map(([key],i)=>`${columns[key]}=$${i+3}`).join(",")} WHERE tenant_id=$1 AND id=$2`,[t,callId,...entries.map(([,v])=>v)]);
      }, emit: async () => {},
    } } as unknown as RevenueDeskDeps;
    const ctx = { config:{tenantId:tenant,escalationPhone:"+13055550100"},call:{id,status:"in_progress"} } as Parameters<typeof completeCall>[1];
    return {
      request:()=>transferDestination(deps,ctx),
      initiate:()=>recordTransferInitiated(deps,ctx),
      end:(reason: string | null)=>completeCall(deps,ctx,{endedReason:reason,endedAt:null,startedAt:null,durationSeconds:null,costUsd:null}),
    };
  }

  it.each(cases)("backfills %s and protects it from late and duplicate initiation", async (name,_reason,_old,_status,expected) => transaction(async c => {
    const id=historical.get(name)!;
    expect(await state(c,id)).toMatchObject({transfer_final:true,escalation_result:expected});
    if(name==="unsupported-success") expect((await state(c,id)).transfer_evidence).toEqual(["unverified_transferred"]);
    if(name==="unsupported-failure") expect((await state(c,id)).transfer_evidence).toEqual(["unverified_transfer_failed"]);
    const a=app(c,id);await a.request();await a.initiate();await a.initiate();await a.request();
    expect(await state(c,id)).toMatchObject({transfer_final:true,escalation_result:expected ?? "unknown"});
  }));

  it("requested then initiated is monotonic and never a human answer", () => transaction(async c => {
    const id=await fresh(c), a=app(c,id);
    await a.request();expect((await state(c,id)).escalation_result).toBe("requested");
    await a.initiate();await a.request();expect((await state(c,id)).escalation_result).toBe("initiated");
    expect(transferLabel.transferred).toContain("human answer unverified");
    expect(transferEvidenceLabel.transferred).toBe("Provider reported forwarding");
  }));

  it.each(["assistant-forwarded-call","call.in-progress.error-transfer-failed","customer-ended-call-during-transfer","unrecognized-provider-reason"])("application and DB agree on %s; duplicates and generic late ends cannot erase evidence", reason => transaction(async c => {
    const id=await fresh(c),a=app(c,id);await a.initiate();await a.end(reason);await a.end(reason);
    const first=await state(c,id);expect(first.escalation_result).toBe(transferOutcome(reason));
    await a.end("customer-ended-call");await a.request();await a.initiate();
    expect((await state(c,id)).escalation_result).toBe(first.escalation_result);
    expect((await state(c,id)).transfer_final).toBe(true);
  }));

  it.each([false,true])("generic end and explicit forwarding agree in either order (reverse=%s)", reverse => transaction(async c => {
    const id=await fresh(c),a=app(c,id);
    for(const reason of reverse?["assistant-forwarded-call","customer-ended-call"]:["customer-ended-call","assistant-forwarded-call"]) await a.end(reason);
    expect(await state(c,id)).toMatchObject({transfer_final:true,escalation_result:"transferred",transfer_evidence:["transferred"]});
  }));

  it.each([false,true])("contradictory terminal reports retain both observations and stay unknown (reverse=%s)", reverse => transaction(async c => {
    const id=await fresh(c),a=app(c,id);
    const reasons=["assistant-forwarded-call","call.in-progress.error-transfer-failed"];
    for(const reason of reverse?reasons.reverse():reasons) await a.end(reason);
    await a.end("assistant-forwarded-call");await a.initiate();
    expect(await state(c,id)).toEqual({transfer_final:true,escalation_result:"unknown",transfer_evidence:["initiated","transfer_failed","transferred"]});
  }));

  it("concurrent contradictory application events converge without losing failure evidence", async () => {
    const c=await pool.connect();const id=await fresh(c);c.release();
    const workers=await Promise.all([pool.connect(),pool.connect()]);
    try {
      await Promise.all(workers.map(async (w,i)=>{
        await w.query("BEGIN");await w.query("SET LOCAL ROLE service_role");
        await app(w,id).end(i?"call.in-progress.error-transfer-failed":"assistant-forwarded-call");await w.query("COMMIT");
      }));
      expect(await state(workers[0],id)).toEqual({transfer_final:true,escalation_result:"unknown",transfer_evidence:["transfer_failed","transferred"]});
    } finally { for(const w of workers){await w.query("ROLLBACK");w.release();} await pool.query(`DELETE FROM revenue_desk_calls WHERE id=$1`,[id]); }
  });

  it("direct supplied evidence cannot erase prior observations or fabricate forwarding", () => transaction(async c => {
    const id=await fresh(c);await app(c,id).initiate();
    await c.query(`UPDATE revenue_desk_calls SET escalation_result='transferred',transfer_final=true,transfer_evidence=ARRAY['transferred'] WHERE id=$1`,[id]);
    expect(await state(c,id)).toEqual({transfer_final:true,escalation_result:"unknown",transfer_evidence:["initiated"]});
  }));
});
