import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { bookingUniqueViolation } from "./booking";
import { getPgTestUrl, getPgTestPool, withRollback, setRole, insertTenant, insertMembership, insertLead, runConcurrently } from "../testHarness/pgTestDb";

/**
 * Revenue Desk (migration 026) — real Postgres proof as real roles.
 * Gated on DATABASE_URL like every *.pg.test.ts; skipped (not passed) without it.
 */
const DESCRIBE = getPgTestUrl() ? describe : describe.skip;
afterAll(async () => { if (getPgTestUrl()) await getPgTestPool().end(); });

type C = import("pg").PoolClient;
async function call(c: C, tenantId: string, providerCallId = `vapi-${randomUUID()}`, leadId: string | null = null) {
  const r = await c.query(`INSERT INTO public.revenue_desk_calls (tenant_id, provider_call_id, lead_id) VALUES ($1,$2,$3) RETURNING id`, [tenantId, providerCallId, leadId]);
  return r.rows[0].id as string;
}
async function booking(c: C, tenantId: string, callId: string, over: { key?: string; start?: string; status?: string; calendar?: string } = {}) {
  const start = over.start ?? "2026-10-12T14:00:00Z";
  return c.query(
    `INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone, status, provider_event_id)
     VALUES ($1,$2,$3,$4,$5::timestamptz,$5::timestamptz + interval '1 hour','America/New_York',$6,$7) RETURNING id`,
    [tenantId, callId, over.key ?? randomUUID(), over.calendar ?? "cal-a", start, over.status ?? "pending", over.status === "confirmed" ? "ev-1" : null]
  );
}
const code = (e: unknown) => (e as { code?: string })?.code;
async function expectCode(c: C, p: () => Promise<unknown>, expected: string) {
  await c.query("SAVEPOINT sp");
  await expect(p()).rejects.toMatchObject({ code: expected });
  await c.query("ROLLBACK TO SAVEPOINT sp");
}

DESCRIBE("Revenue Desk schema + RLS (real Postgres)", () => {
  it("members read only their own tenant's settings/calls/bookings; strangers and other tenants see nothing", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c), tB = await insertTenant(c);
      const uA = randomUUID(), uB = randomUUID();
      await insertMembership(c, tA, uA); await insertMembership(c, tB, uB);
      for (const t of [tA, tB]) {
        await c.query(`INSERT INTO public.revenue_desk_settings (tenant_id, escalation_phone, calendar_id) VALUES ($1,'+13055550100','cal')`, [t]);
        await booking(c, t, await call(c, t));
      }
      await setRole(c, "authenticated", uA);
      for (const table of ["revenue_desk_settings", "revenue_desk_calls", "revenue_desk_bookings"]) {
        const rows = (await c.query(`SELECT tenant_id FROM public.${table}`)).rows.map((r) => r.tenant_id);
        expect(rows, table).toEqual([tA]);
      }
    }));

  it("tenant members cannot write config (escalation phone/calendar), calls, or bookings", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c); const uA = randomUUID(); await insertMembership(c, tA, uA);
      await c.query(`INSERT INTO public.revenue_desk_settings (tenant_id, escalation_phone) VALUES ($1,'+13055550100')`, [tA]);
      const callId = await call(c, tA);
      await setRole(c, "authenticated", uA);
      expect((await c.query(`UPDATE public.revenue_desk_settings SET escalation_phone='+19995550000', enabled=true WHERE tenant_id=$1`, [tA])).rowCount).toBe(0);
      expect((await c.query(`UPDATE public.revenue_desk_calls SET status='booked' WHERE tenant_id=$1`, [tA])).rowCount).toBe(0);
      await expectCode(c, () => c.query(`INSERT INTO public.revenue_desk_calls (tenant_id, provider_call_id) VALUES ($1,'x')`, [tA]), "42501");
      await expectCode(c, () => booking(c, tA, callId), "42501");
    }));

  it("anon is refused", () =>
    withRollback(async (c) => {
      await setRole(c, "anon");
      await expect(c.query(`SELECT 1 FROM public.revenue_desk_calls`)).rejects.toMatchObject({ code: "42501" });
    }));

  it("duplicate provider call id per tenant is refused (replay-safe); same id under another tenant is isolated", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c), tB = await insertTenant(c);
      await call(c, tA, "vapi-dup");
      await expectCode(c, () => call(c, tA, "vapi-dup"), "23505");
      await call(c, tB, "vapi-dup");
    }));

  it("call/booking cannot reference another tenant's lead or call (composite FKs)", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c), tB = await insertTenant(c);
      const leadB = await insertLead(c, tB);
      await expectCode(c, () => call(c, tA, undefined, leadB), "23503");
      const callB = await call(c, tB);
      await expectCode(c, () => booking(c, tA, callB), "23503");
      const leadA = await insertLead(c, tA);
      await call(c, tA, undefined, leadA); // same-tenant link is fine
    }));

  it("booking idempotency key, one live booking per call, and the per-calendar slot guard are DB-enforced", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c);
      const c1 = await call(c, tA), c2 = await call(c, tA);
      await booking(c, tA, c1, { key: "k1" });
      await expectCode(c, () => booking(c, tA, c2, { key: "k1", start: "2026-10-13T14:00:00Z" }), "23505"); // idempotency
      await expectCode(c, () => booking(c, tA, c1, { start: "2026-10-14T14:00:00Z" }), "23505"); // live per call
      await expectCode(c, () => booking(c, tA, c2), "23505"); // same slot, same calendar
      await booking(c, tA, c2, { calendar: "cal-other" }); // other calendar ok
      await c.query(`UPDATE public.revenue_desk_bookings SET status='conflict' WHERE idempotency_key='k1'`);
      const c3 = await call(c, tA);
      await booking(c, tA, c3); // slot reopens once the earlier booking is no longer live
    }));

  it("confirmed requires a provider event id; end must follow start", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c); const c1 = await call(c, tA);
      await expectCode(c, () => c.query(`INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone, status) VALUES ($1,$2,'k','cal',now(),now()+interval '1h','UTC','confirmed')`, [tA, c1]), "23514");
      await expectCode(c, () => c.query(`INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone) VALUES ($1,$2,'k2','cal',now(),now()-interval '1h','UTC')`, [tA, c1]), "23514");
    }));

  it("canonical voice lead is idempotent on (tenant, source, source_ref=callId)", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c); const ref = randomUUID();
      const lead = async () => {
        const id = await insertLead(c, tA);
        await c.query(`UPDATE public.leads SET source='voice_receptionist', source_ref=$1 WHERE id=$2`, [ref, id]);
      };
      await lead();
      await expectCode(c, () => lead(), "23505");
    }));
});

DESCRIBE("H001 atomic corrections and evidence (proposal 028, disposable Postgres)", () => {
  function inputs(callId: string, address = "1 Test St") {
    return { id: randomUUID(), date: "2026-10-15T00:00:00Z", source: "voice_receptionist", source_ref: callId,
      customer_name: "Synthetic", phone: "+13055550123", service_address: address, property_type: "Other", service_type: "Other",
      emergency: "No", urgency: "Flexible", job_description: "Synthetic job", customer_role: "Other", lead_source: "Other" };
  }
  async function save(c: C, tenant: string, id: string, revision: number, request: string, address = "1 Test St", priority = "routine") {
    const lead = inputs(id,address);
    return (await c.query(`SELECT public.revenue_desk_save_intake($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,ARRAY[]::text[],'Other') result`,
      [tenant,id,revision,request,JSON.stringify(lead),JSON.stringify({ customerName: "Synthetic", serviceAddress: address }),priority])).rows[0].result;
  }
  it("correction updates the same canonical lead and call atomically without resetting lifecycle/provenance", () => withRollback(async c => {
    const t = await insertTenant(c), id = await call(c,t);
    const first = await save(c,t,id,0,"initial");
    await c.query(`UPDATE leads SET status='Contacted',estimate_amount=123,internal_notes='owner',sms_sent_at=now() WHERE id=$1`, [first.lead.id]);
    const corrected = await save(c,t,id,1,"correction","2 Correct St");
    expect(corrected.lead).toMatchObject({ id:first.lead.id,service_address:"2 Correct St",status:"Contacted",estimate_amount:123,internal_notes:"owner",source:"voice_receptionist",source_ref:id });
    expect(corrected.lead.sms_sent_at).not.toBeNull();
    expect(corrected.lead.received_at).toBe(first.lead.received_at);
    expect(corrected.call).toMatchObject({ lead_id:first.lead.id,intake_revision:2,intake:{serviceAddress:"2 Correct St"} });
    expect((await c.query(`SELECT count(*)::int n FROM leads WHERE tenant_id=$1`,[t])).rows[0].n).toBe(1);
    expect((await save(c,t,id,1,"correction","2 Correct St")).call.intake_revision).toBe(2);
    await expectCode(c,()=>save(c,t,id,2,"initial"),"P0001");
    await expectCode(c,()=>save(c,t,id,1,"stale","3 Wrong St"),"P0001");
    expect((await c.query(`SELECT intake FROM revenue_desk_calls WHERE id=$1`,[id])).rows[0].intake.serviceAddress).toBe("2 Correct St");
  }));
  it("a call constraint failure after lead UPDATE rolls back the correction and receipt", () => withRollback(async c => {
    const t=await insertTenant(c),id=await call(c,t); const before=await save(c,t,id,0,"initial");
    await expectCode(c,()=>save(c,t,id,1,"fault","2 Wrong St","invalid-priority"),"23514");
    expect((await c.query(`SELECT service_address FROM leads WHERE id=$1`,[before.lead.id])).rows[0].service_address).toBe("1 Test St");
    expect((await c.query(`SELECT intake_revision FROM revenue_desk_calls WHERE id=$1`,[id])).rows[0].intake_revision).toBe(1);
    expect((await c.query(`SELECT count(*)::int n FROM revenue_desk_intake_receipts WHERE call_id=$1`,[id])).rows[0].n).toBe(1);
  }));
  it.each(["initial", "identical-new-id", "genuine-correction"])("F01 rejects canonical drift for %s without overwriting owner edits or writing a receipt", op => withRollback(async c => {
    const t=await insertTenant(c),id=await call(c,t);
    const first=await save(c,t,id,0,"initial");
    await c.query(`UPDATE leads SET service_address='2 Owner Corrected St' WHERE tenant_id=$1 AND id=$2`,[t,first.lead.id]);
    await expectCode(c,()=>save(c,t,id,1,op,op==="genuine-correction"?"3 Caller Correction St":"1 Test St"),"P0001");
    expect((await c.query(`SELECT service_address FROM leads WHERE tenant_id=$1 AND id=$2`,[t,first.lead.id])).rows[0].service_address).toBe("2 Owner Corrected St");
    expect((await c.query(`SELECT intake_revision,intake FROM revenue_desk_calls WHERE id=$1`,[id])).rows[0]).toMatchObject({intake_revision:1,intake:{serviceAddress:"1 Test St"}});
    expect((await c.query(`SELECT count(*)::int n FROM revenue_desk_intake_receipts WHERE call_id=$1`,[id])).rows[0].n).toBe(1);
  }));
  it("F01 exact replay stays idempotent after lifecycle-only owner changes", () => withRollback(async c => {
    const t=await insertTenant(c),id=await call(c,t);const first=await save(c,t,id,0,"initial");
    await c.query(`UPDATE leads SET status='Contacted',internal_notes='Owner note',estimate_amount=42 WHERE id=$1`,[first.lead.id]);
    const replay=await save(c,t,id,0,"initial");
    expect(replay).toMatchObject({deduped:true,lead:{id:first.lead.id,status:"Contacted",internal_notes:"Owner note",estimate_amount:42},call:{intake_revision:1}});
    expect(replay.call.intake_lead_snapshot).toEqual(first.call.intake_lead_snapshot);
  }));
  it("F01 refuses legacy intake without independently accepted canonical snapshot", () => withRollback(async c => {
    const t=await insertTenant(c),id=await call(c,t);const first=await save(c,t,id,0,"initial");
    await c.query(`UPDATE revenue_desk_calls SET intake_lead_snapshot=NULL,intake_digest=NULL,intake_revision=0 WHERE id=$1`,[id]);
    await expectCode(c,()=>save(c,t,id,0,"legacy-replay","2 Stale St"),"P0001");
    expect((await c.query(`SELECT service_address FROM leads WHERE id=$1`,[first.lead.id])).rows[0].service_address).toBe("1 Test St");
  }));
  it("F01 a missing accepted lead cannot be silently replaced on replay", () => withRollback(async c => {
    const t=await insertTenant(c),id=await call(c,t);const first=await save(c,t,id,0,"initial");
    await c.query(`DELETE FROM leads WHERE id=$1`,[first.lead.id]);
    await expectCode(c,()=>save(c,t,id,1,"initial"),"P0001");
    expect((await c.query(`SELECT count(*)::int n FROM leads WHERE tenant_id=$1`,[t])).rows[0].n).toBe(0);
  }));
  it("cross-tenant binding and member/anon RPC execution are refused", () => withRollback(async c => {
    const a=await insertTenant(c), b=await insertTenant(c),id=await call(c,a);
    await expectCode(c,()=>save(c,b,id,0,"foreign"),"P0002");
    const user=randomUUID(); await insertMembership(c,a,user);
    for (const role of ["authenticated","anon"] as const) {
      await c.query("SAVEPOINT rolecheck"); await setRole(c,role,user);
      await expect(save(c,a,id,0,"blocked")).rejects.toMatchObject({code:"42501"});
      await c.query("ROLLBACK TO SAVEPOINT rolecheck");
    }
  }));
  it("concurrent corrections with the same expected revision have exactly one transaction winner", async () => {
    const pool=getPgTestPool(); const c=await pool.connect(); let t="";
    try {
      t=await insertTenant(c); const id=await call(c,t); await save(c,t,id,0,"initial");
      const results=await runConcurrently(["2 A St","3 B St"].map((address,i)=>async conn=> {
        await conn.query("BEGIN"); const r=await save(conn,t,id,1,`correction-${i}`,address); await conn.query("COMMIT"); return r;
      }));
      expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
      const joined=(await c.query(`SELECT l.service_address,c.intake,c.intake_revision FROM revenue_desk_calls c JOIN leads l ON l.id=c.lead_id AND l.tenant_id=c.tenant_id WHERE c.id=$1`,[id])).rows[0];
      expect(joined.intake_revision).toBe(2); expect(joined.service_address).toBe(joined.intake.serviceAddress);
      expect((await c.query(`SELECT count(*)::int n FROM leads WHERE tenant_id=$1`,[t])).rows[0].n).toBe(1);
    } finally { if(t) await c.query(`DELETE FROM tenants WHERE id=$1`,[t]); c.release(); }
  });
  it("duplicate and out-of-order transfer callbacks cannot downgrade or invent human-answer evidence", () => withRollback(async c => {
    const t=await insertTenant(c), id=await call(c,t);
    const state=async(result:string,final=false)=> {
      const reason=result==="transferred"?"assistant-forwarded-call":result==="transfer_failed"?"call.in-progress.error-transfer-failed":null;
      await c.query(`UPDATE revenue_desk_calls SET escalation_result=$2,transfer_final=$3,ended_reason=coalesce($4,ended_reason) WHERE id=$1`,[id,result,final,reason]);
      return (await c.query(`SELECT escalation_result,transfer_final FROM revenue_desk_calls WHERE id=$1`,[id])).rows[0];
    };
    expect((await state("requested")).escalation_result).toBe("requested");
    expect((await state("initiated")).escalation_result).toBe("initiated");
    expect((await state("requested")).escalation_result).toBe("initiated");
    expect((await state("transferred",true)).escalation_result).toBe("transferred");
    expect((await state("transferred",true)).escalation_result).toBe("transferred");
    expect(await state("initiated")).toEqual({escalation_result:"transferred",transfer_final:true});
    expect((await state("transfer_failed",true)).escalation_result).toBe("unknown");
    expect((await state("transferred",true)).escalation_result).toBe("unknown");
  }));
  it("call-end before transfer notification yields unknown, never a successful handoff", () => withRollback(async c => {
    const t=await insertTenant(c),id=await call(c,t);
    await c.query(`UPDATE revenue_desk_calls SET transfer_final=true,escalation_result='unknown',ended_reason='customer-ended-call' WHERE id=$1`,[id]);
    expect((await c.query(`SELECT escalation_result FROM revenue_desk_calls WHERE id=$1`,[id])).rows[0].escalation_result).toBeNull();
    await c.query(`UPDATE revenue_desk_calls SET transfer_final=true,escalation_result='unknown',ended_reason='customer-ended-call' WHERE id=$1`,[id]);
    expect((await c.query(`SELECT escalation_result FROM revenue_desk_calls WHERE id=$1`,[id])).rows[0].escalation_result).toBeNull();
    await c.query(`UPDATE revenue_desk_calls SET escalation_result='initiated' WHERE id=$1`,[id]);
    expect((await c.query(`SELECT escalation_result FROM revenue_desk_calls WHERE id=$1`,[id])).rows[0].escalation_result).toBe("unknown");
  }));
  it("lease takeover fences the former writer and a process-interrupted row remains in the owner queue", () => withRollback(async c => {
    const t=await insertTenant(c),id=await call(c,t);
    const b=(await c.query(`INSERT INTO revenue_desk_bookings(tenant_id,call_id,idempotency_key,calendar_id,requested_start,requested_end,timezone,updated_at) VALUES($1,$2,'interrupted','cal',now(),now()+interval '1h','UTC',now()-interval '1 minute') RETURNING *`,[t,id])).rows[0];
    const claimed=(await c.query(`SELECT * FROM revenue_desk_claim_booking_lease($1,$2,45)`,[t,b.id])).rows[0];
    expect(claimed.lease_token).not.toBe(b.lease_token);
    expect((await c.query(`UPDATE revenue_desk_bookings SET status='confirmed',provider_event_id='late' WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND status='pending'`,[t,b.id,b.lease_token])).rowCount).toBe(0);
    expect((await c.query(`SELECT id FROM revenue_desk_bookings WHERE tenant_id=$1 AND status='pending'`,[t])).rows.map(r=>r.id)).toEqual([b.id]);
    expect((await c.query(`SELECT escalation_reason FROM revenue_desk_calls WHERE id=$1`,[id])).rows[0].escalation_reason).toBeNull();
  }));
  it("confirmed recovery updates the call summary in the same transaction and retains the promised follow-up", () => withRollback(async c => {
    const t=await insertTenant(c),id=await call(c,t);
    await c.query(`UPDATE revenue_desk_calls SET escalation_reason='booking_pending_confirmation',escalation_result='requested' WHERE id=$1`,[id]);
    const b=(await booking(c,t,id)).rows[0].id;
    await setRole(c,"service_role");
    await c.query(`UPDATE revenue_desk_bookings SET status='confirmed',provider_event_id='verified-event' WHERE id=$1 AND tenant_id=$2`,[b,t]);
    expect((await c.query(`SELECT status,booking_outcome,escalation_reason FROM revenue_desk_calls WHERE id=$1`,[id])).rows[0]).toEqual({status:"booked",booking_outcome:"confirmed",escalation_reason:"booking_pending_confirmation"});
  }));
  it("intake receipts are tenant-readable and immutable to members", () => withRollback(async c => {
    const a=await insertTenant(c),b=await insertTenant(c),user=randomUUID();
    await insertMembership(c,a,user); await save(c,a,await call(c,a),0,"a"); await save(c,b,await call(c,b),0,"b");
    await setRole(c,"authenticated",user);
    expect((await c.query(`SELECT tenant_id FROM revenue_desk_intake_receipts`)).rows.map(r=>r.tenant_id)).toEqual([a]);
    expect((await c.query(`UPDATE revenue_desk_intake_receipts SET revision=999`)).rowCount).toBe(0);
    expect((await c.query(`DELETE FROM revenue_desk_intake_receipts`)).rowCount).toBe(0);
  }));
});

DESCRIBE("Revenue Desk concurrency (separate real transactions)", () => {
  it("concurrent duplicate callbacks create exactly one call row", async () => {
    const pool = getPgTestPool();
    const tA = (await pool.query(`INSERT INTO public.tenants (name, slug) VALUES ('rd-conc', $1) RETURNING id`, [`rd-${randomUUID()}`])).rows[0].id;
    try {
      const results = await runConcurrently(Array.from({ length: 5 }, () => async (c: C) => {
        await c.query("BEGIN");
        await c.query(`INSERT INTO public.revenue_desk_calls (tenant_id, provider_call_id) VALUES ($1,'same-call')`, [tA]);
        await c.query("COMMIT");
      }));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected").every((r) => code((r as any).reason) === "23505")).toBe(true);
      expect((await pool.query(`SELECT count(*)::int n FROM public.revenue_desk_calls WHERE tenant_id=$1`, [tA])).rows[0].n).toBe(1);
    } finally {
      await pool.query(`DELETE FROM public.tenants WHERE id=$1`, [tA]);
    }
  });

  it("concurrent booking attempts for the same slot: exactly one live booking", async () => {
    const pool = getPgTestPool();
    const tA = (await pool.query(`INSERT INTO public.tenants (name, slug) VALUES ('rd-conc2', $1) RETURNING id`, [`rd-${randomUUID()}`])).rows[0].id;
    try {
      const callIds = [];
      for (let i = 0; i < 4; i++) callIds.push((await pool.query(`INSERT INTO public.revenue_desk_calls (tenant_id, provider_call_id) VALUES ($1,$2) RETURNING id`, [tA, `c${i}`])).rows[0].id);
      const results = await runConcurrently(callIds.map((id) => async (c: C) => {
        await c.query("BEGIN");
        await c.query(`INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone) VALUES ($1,$2,$3,'cal','2026-10-12T14:00:00Z','2026-10-12T15:00:00Z','UTC')`, [tA, id, `k-${id}`]);
        await c.query("COMMIT");
      }));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await pool.query(`SELECT count(*)::int n FROM public.revenue_desk_bookings WHERE tenant_id=$1`, [tA])).rows[0].n).toBe(1);
    } finally {
      await pool.query(`DELETE FROM public.tenants WHERE id=$1`, [tA]);
    }
  });

  it("concurrent IDENTICAL booking inserts: one winner; every loser's real 23505 message maps to a typed guard (never a generic failure)", async () => {
    const pool = getPgTestPool();
    const tA = (await pool.query(`INSERT INTO public.tenants (name, slug) VALUES ('rd-conc3', $1) RETURNING id`, [`rd-${randomUUID()}`])).rows[0].id;
    try {
      const callId = (await pool.query(`INSERT INTO public.revenue_desk_calls (tenant_id, provider_call_id) VALUES ($1,'dup') RETURNING id`, [tA])).rows[0].id;
      const results = await runConcurrently(Array.from({ length: 6 }, () => async (c: C) => {
        await c.query("BEGIN");
        await c.query(`INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone) VALUES ($1,$2,'same-key','cal','2026-10-12T14:00:00Z','2026-10-12T15:00:00Z','UTC')`, [tA, callId]);
        await c.query("COMMIT");
      }));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const losers = results.filter((r) => r.status === "rejected").map((r) => (r as any).reason);
      expect(losers.every((e) => code(e) === "23505" && bookingUniqueViolation(e.message) !== null)).toBe(true);
      // A plain sequential duplicate reports a guard the store also maps.
      const seq = await pool.query(`INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone) VALUES ($1,$2,'same-key','cal','2026-10-12T14:00:00Z','2026-10-12T15:00:00Z','UTC')`, [tA, callId]).catch((e) => e);
      expect(bookingUniqueViolation(seq.message)).not.toBeNull();
      expect((await pool.query(`SELECT count(*)::int n FROM public.revenue_desk_bookings WHERE tenant_id=$1`, [tA])).rows[0].n).toBe(1);
    } finally {
      await pool.query(`DELETE FROM public.tenants WHERE id=$1`, [tA]);
    }
  });

  it("migration 027 lease RPC: of concurrent service-role claimers on an expired lease, exactly one wins (database clock only)", async () => {
    const pool = getPgTestPool();
    const tA = (await pool.query(`INSERT INTO public.tenants (name, slug) VALUES ('rd-conc4', $1) RETURNING id`, [`rd-${randomUUID()}`])).rows[0].id;
    try {
      const callId = (await pool.query(`INSERT INTO public.revenue_desk_calls (tenant_id, provider_call_id) VALUES ($1,'lease') RETURNING id`, [tA])).rows[0].id;
      // Lease last written 10 minutes ago by the database.
      const id = (await pool.query(`INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone, updated_at) VALUES ($1,$2,'lease-key','cal','2026-10-12T14:00:00Z','2026-10-12T15:00:00Z','UTC', now() - interval '10 minutes') RETURNING id`, [tA, callId])).rows[0].id;
      const results = await runConcurrently(Array.from({ length: 6 }, () => async (c: C) => {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE service_role");
        const r = await c.query(`SELECT id FROM public.revenue_desk_claim_booking_lease($1, $2, 45)`, [tA, id]);
        await c.query("COMMIT");
        return r.rowCount;
      }));
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      expect(results.map((r) => (r as any).value).filter((n) => n === 1)).toHaveLength(1);
      // The winner's claim refreshed the lease with the DB clock: an immediate re-claim is refused.
      expect((await pool.query(`SELECT * FROM public.revenue_desk_claim_booking_lease($1, $2, 45)`, [tA, id])).rowCount).toBe(0);
    } finally {
      await pool.query(`DELETE FROM public.tenants WHERE id=$1`, [tA]);
    }
  });
});

DESCRIBE("Revenue Desk booking lease (migration 027, real Postgres)", () => {
  const claim = (c: C, t: string, id: string, secs = 45) => c.query(`SELECT * FROM public.revenue_desk_claim_booking_lease($1, $2, $3)`, [t, id, secs]);
  async function pendingRow(c: C, t: string, ageSql = "0 seconds") {
    const callId = await call(c, t);
    return (await c.query(`INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone, updated_at) VALUES ($1,$2,$3,$3,'2026-10-12T14:00:00Z','2026-10-12T15:00:00Z','UTC', now() - $4::interval) RETURNING id`, [t, callId, randomUUID(), ageSql])).rows[0].id as string;
  }

  it("a fresh (DB-timestamped) pending lease cannot be claimed; an expired one can, once", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c);
      await setRole(c, "service_role");
      expect((await claim(c, tA, await pendingRow(c, tA))).rowCount).toBe(0);
      const old = await pendingRow(c, tA, "1 minute");
      expect((await claim(c, tA, old)).rowCount).toBe(1);
      expect((await claim(c, tA, old)).rowCount).toBe(0);
    }));

  it("application-supplied updated_at is ignored: the trigger stamps the database clock, so app skew cannot expire or extend a lease", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c);
      const id = await pendingRow(c, tA, "1 minute");
      // An app clock far in the PAST would make the lease look expired forever...
      await c.query(`UPDATE public.revenue_desk_bookings SET updated_at = '2000-01-01T00:00:00Z' WHERE id=$1`, [id]);
      expect((await c.query(`SELECT updated_at = now() AS db FROM public.revenue_desk_bookings WHERE id=$1`, [id])).rows[0].db).toBe(true);
      await setRole(c, "service_role");
      expect((await claim(c, tA, id)).rowCount).toBe(0);
      // ...and one far in the FUTURE would hold a dead lease forever.
      const id2 = await pendingRow(c, tA, "1 minute");
      await c.query(`SET LOCAL ROLE postgres`);
      await c.query(`UPDATE public.revenue_desk_bookings SET failure_category = NULL, updated_at = '2999-01-01T00:00:00Z' WHERE id=$1`, [id2]);
      expect((await c.query(`SELECT updated_at <= now() AS sane FROM public.revenue_desk_bookings WHERE id=$1`, [id2])).rows[0].sane).toBe(true);
    }));

  it("never claims another tenant's row, a settled row, or with an out-of-range lease", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c), tB = await insertTenant(c);
      const old = await pendingRow(c, tA, "10 minutes");
      const settled = (await c.query(`INSERT INTO public.revenue_desk_bookings (tenant_id, call_id, idempotency_key, calendar_id, requested_start, requested_end, timezone, status, failure_category, updated_at) VALUES ($1,$2,$3,'cal','2026-10-13T14:00:00Z','2026-10-13T15:00:00Z','UTC','conflict','SLOT_UNAVAILABLE', now() - interval '10 minutes') RETURNING id`, [tA, await call(c, tA), randomUUID()])).rows[0].id;
      await setRole(c, "service_role");
      expect((await claim(c, tB, old)).rowCount).toBe(0);
      expect((await claim(c, tA, settled)).rowCount).toBe(0);
      expect((await claim(c, tA, old, 0)).rowCount).toBe(0);
      expect((await claim(c, tA, old, 99999)).rowCount).toBe(0);
      expect((await claim(c, tA, old)).rowCount).toBe(1);
    }));

  it("anon and authenticated cannot execute the lease RPC", () =>
    withRollback(async (c) => {
      const tA = await insertTenant(c); const uA = randomUUID(); await insertMembership(c, tA, uA);
      const id = await pendingRow(c, tA, "10 minutes");
      await c.query("SAVEPOINT sp");
      await setRole(c, "authenticated", uA);
      await expect(claim(c, tA, id)).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT sp");
      await setRole(c, "anon");
      await expect(claim(c, tA, id)).rejects.toMatchObject({ code: "42501" });
    }));
});
