import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getPgTestPool, getPgTestUrl, insertLead, insertMembership, insertTenant } from "@/lib/testHarness/pgTestDb";
import { pgSupabaseAdapter } from "@/lib/testHarness/pgSupabaseAdapter";

/**
 * Owner Evidence Persistence Hotfix — real PostgreSQL/RLS-aware coverage.
 *
 * Reproduces the exact production defect (business_events has always had
 * SELECT-only RLS — business_events_select_tenant, migration 009 — with no
 * authenticated INSERT policy) and proves the fix: review/follow-through
 * writes now succeed via the narrowly-scoped, independently re-verified
 * evidence writer (lib/agents/estimateClosing/evidenceEvent.server.ts),
 * while a plain authenticated (or anonymous) attempt to INSERT an arbitrary
 * business_events row remains impossible — exactly like
 * lib/leads/estimateLifecycle.rls.pg.test.ts's identical role-boundary
 * proof for estimate.sent.
 */

const actor = vi.hoisted(() => ({ tenantId: "", userId: "", role: "owner" as "owner" | "staff", authorized: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/api-auth", () => ({ checkAuth: async () => (actor.authorized ? { authenticated: true } : { authenticated: false, response: new Response(null, { status: 401 }) }) }));
vi.mock("@/lib/tenant", () => ({
  getTenantContext: async () => (actor.authorized ? { tenantId: actor.tenantId, tenantName: "Synthetic", tenantSlug: "synthetic", role: actor.role, userId: actor.userId } : null),
}));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: async () => pgSupabaseAdapter((sql, params) => roleQuery(sql, params, "authenticated")) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => pgSupabaseAdapter((sql, params) => roleQuery(sql, params, "service_role")) }));

import { POST as reviewPOST } from "@/app/api/agents/estimate-closing/recommendations/[eventId]/review/route";
import { POST as followThroughPOST } from "@/app/api/agents/estimate-closing/recommendations/[eventId]/followthrough/route";
import { emitEstimateSentEvent } from "@/lib/leads/estimateLifecycleEvent.server";

/** Same production surface exercised through the real role boundary —
 * owner JWT (authenticated) for the plain client, private service role for
 * the elevated writer — mirrors estimateLifecycle.rls.pg.test.ts's own
 * roleQuery exactly. */
async function roleQuery(sql: string, params: unknown[], role: "authenticated" | "service_role") {
  const c = await getPgTestPool().connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor.userId })]);
    const result = await c.query(sql, params);
    await c.query("COMMIT");
    return result;
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}

const DESCRIBE = getPgTestUrl() ? describe : describe.skip;

let tenantId: string;
let otherTenantId: string;
let leadId: string;
let otherLeadId: string;
let recommendationEventId: string;
let otherRecommendationEventId: string;

const rows = (table: string, tid = tenantId) => getPgTestPool().query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [tid]);

async function insertRecommendation(tid: string, lid: string): Promise<string> {
  const id = randomUUID();
  await getPgTestPool().query(
    `INSERT INTO public.business_events (id, tenant_id, event_type, actor_type, entity_type, entity_id, payload)
     VALUES ($1, $2, 'estimate.closing_recommendation_generated', 'agent', 'lead', $3, $4::jsonb)`,
    [
      id,
      tid,
      lid,
      JSON.stringify({
        agentRunId: null,
        sequenceId: null,
        recommendation: "follow_up",
        confidence: 0.8,
        reasonCodes: ["no_response_since_sent"],
        suggestedChannel: "sms",
        suggestedTiming: "within_24_hours",
        opportunityValue: 500,
      }),
    ]
  );
  return id;
}

const reviewReq = (eventId: string, body: unknown) =>
  reviewPOST(new NextRequest(`https://example.test/api/agents/estimate-closing/recommendations/${eventId}/review`, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ eventId }),
  });

const followThroughReq = (eventId: string, body: unknown) =>
  followThroughPOST(new NextRequest(`https://example.test/api/agents/estimate-closing/recommendations/${eventId}/followthrough`, { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ eventId }),
  });

const validReviewBody = { verdict: "agree", wouldAct: "yes", reasonCodes: ["recommendation_correct"] };
const validFollowThroughBody = (submissionId: string) => ({
  actionTaken: "yes",
  actionChannel: "sms",
  customerResponse: "not_observed",
  businessDisposition: "pending",
  submissionId,
});

DESCRIBE("Estimate Closing owner evidence (review + follow-through) — real authenticated/RLS persistence", () => {
  beforeEach(async () => {
    actor.authorized = true;
    actor.role = "owner";
    actor.userId = randomUUID();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://synthetic.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-never-transmitted");
    const c = await getPgTestPool().connect();
    try {
      tenantId = await insertTenant(c);
      otherTenantId = await insertTenant(c);
      actor.tenantId = tenantId;
      await insertMembership(c, tenantId, actor.userId, "owner");
      leadId = await insertLead(c, tenantId, { status: "Estimate Sent", estimateAmount: 500 });
      otherLeadId = await insertLead(c, otherTenantId, { status: "Estimate Sent", estimateAmount: 500 });
    } finally {
      c.release();
    }
    recommendationEventId = await insertRecommendation(tenantId, leadId);
    otherRecommendationEventId = await insertRecommendation(otherTenantId, otherLeadId);
  });

  afterEach(async () => {
    await getPgTestPool().query("DELETE FROM tenants WHERE id=ANY($1::uuid[])", [[tenantId, otherTenantId]]);
    await getPgTestPool().query("DELETE FROM auth.users WHERE id=$1", [actor.userId]);
    vi.unstubAllEnvs();
  });

  // A + B — authenticated owner can record a valid review; exactly one
  // review event is created. Reproduces the exact production defect: this
  // INSERT would previously fail under plain authenticated RLS.
  it("A/B: authenticated owner records a valid review, creating exactly one review event", async () => {
    const r = await reviewReq(recommendationEventId, validReviewBody);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ review: { verdict: "agree", wouldAct: "yes" }, alreadyReviewed: false });
    const events = (await rows("business_events")).rows.filter((e) => e.event_type === "estimate.closing_recommendation_reviewed");
    expect(events).toHaveLength(1);
    expect(events[0].causation_id).toBe(recommendationEventId);
    expect(events[0].actor_id).toBe(actor.userId);
  });

  // C — repeat same review dedupes to the original event.
  it("C: repeat review submission dedupes to the original event, never creating a second row", async () => {
    const first = await reviewReq(recommendationEventId, validReviewBody);
    expect(first.status).toBe(200);
    const second = await reviewReq(recommendationEventId, { verdict: "disagree", wouldAct: "no", reasonCodes: [] });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ alreadyReviewed: true, review: { verdict: "agree", wouldAct: "yes" } });
    const events = (await rows("business_events")).rows.filter((e) => e.event_type === "estimate.closing_recommendation_reviewed");
    expect(events).toHaveLength(1);
  });

  // D — non-owner cannot record review.
  it("D: a non-owner (staff) cannot record a review", async () => {
    actor.role = "staff";
    const r = await reviewReq(recommendationEventId, validReviewBody);
    expect(r.status).toBe(403);
    const events = (await rows("business_events")).rows.filter((e) => e.event_type === "estimate.closing_recommendation_reviewed");
    expect(events).toHaveLength(0);
  });

  // E — cross-tenant recommendation id rejected.
  it("E: a cross-tenant recommendation id is rejected as not found, never leaking the other tenant's row", async () => {
    const r = await reviewReq(otherRecommendationEventId, validReviewBody);
    expect(r.status).toBe(404);
    const events = (await rows("business_events", otherTenantId)).rows.filter((e) => e.event_type === "estimate.closing_recommendation_reviewed");
    expect(events).toHaveLength(0);
  });

  // F — malformed verdict/wouldAct/reasonCodes rejected.
  it("F: malformed verdict/wouldAct/reasonCodes are rejected with 400, nothing persisted", async () => {
    expect((await reviewReq(recommendationEventId, { verdict: "definitely", wouldAct: "yes", reasonCodes: [] })).status).toBe(400);
    expect((await reviewReq(recommendationEventId, { verdict: "agree", wouldAct: "maybe", reasonCodes: [] })).status).toBe(400);
    expect((await reviewReq(recommendationEventId, { verdict: "agree", wouldAct: "yes", reasonCodes: ["not_a_real_code"] })).status).toBe(400);
    const events = (await rows("business_events")).rows.filter((e) => e.event_type === "estimate.closing_recommendation_reviewed");
    expect(events).toHaveLength(0);
  });

  // G + H — authenticated owner can record follow-through; a valid new
  // submissionId creates one append-only event.
  it("G/H: authenticated owner records follow-through with a new submissionId, creating one event", async () => {
    const r = await followThroughReq(recommendationEventId, validFollowThroughBody(randomUUID()));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ followThrough: { actionTaken: "yes", actionChannel: "sms" }, deduped: false });
    const events = (await rows("business_events")).rows.filter((e) => e.event_type === "estimate.closing_recommendation_followthrough_recorded");
    expect(events).toHaveLength(1);
    expect(events[0].causation_id).toBe(recommendationEventId);
  });

  // I — retry with the SAME submissionId dedupes.
  it("I: retrying the same submissionId dedupes to one event", async () => {
    const submissionId = randomUUID();
    expect((await followThroughReq(recommendationEventId, validFollowThroughBody(submissionId))).status).toBe(200);
    const second = await followThroughReq(recommendationEventId, validFollowThroughBody(submissionId));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ deduped: true });
    const events = (await rows("business_events")).rows.filter((e) => e.event_type === "estimate.closing_recommendation_followthrough_recorded");
    expect(events).toHaveLength(1);
  });

  // J — a NEW submissionId permits a later correction, appending a second
  // event rather than editing the first (append-only evidence).
  it("J: a new submissionId records a genuine correction as a second, additional event", async () => {
    await followThroughReq(recommendationEventId, validFollowThroughBody(randomUUID()));
    const correction = await followThroughReq(recommendationEventId, { actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won", submissionId: randomUUID() });
    expect(correction.status).toBe(200);
    expect(await correction.json()).toMatchObject({ deduped: false, followThrough: { businessDisposition: "won" } });
    const events = (await rows("business_events")).rows.filter((e) => e.event_type === "estimate.closing_recommendation_followthrough_recorded");
    expect(events).toHaveLength(2);
  });

  // K — cross-tenant follow-through rejected.
  it("K: a cross-tenant recommendation id is rejected for follow-through too", async () => {
    const r = await followThroughReq(otherRecommendationEventId, validFollowThroughBody(randomUUID()));
    expect(r.status).toBe(404);
    const events = (await rows("business_events", otherTenantId)).rows.filter((e) => e.event_type === "estimate.closing_recommendation_followthrough_recorded");
    expect(events).toHaveLength(0);
  });

  // L — arbitrary business_event INSERT remains impossible to the
  // authenticated user, even after a successful review — proves the fix
  // narrows write authority to exactly the two evidence event types
  // through the verified path, never opening a general INSERT policy.
  it("L: authenticated clients still cannot write an arbitrary business_events row directly", async () => {
    await reviewReq(recommendationEventId, validReviewBody);
    await expect(roleQuery("INSERT INTO business_events(tenant_id,event_type) VALUES ($1,'estimate.closing_recommendation_reviewed')", [tenantId], "authenticated")).rejects.toMatchObject({
      code: "42501",
    });
  });

  // M — anonymous INSERT remains impossible.
  it("M: anonymous clients cannot insert into business_events", async () => {
    await expect(roleQuery("INSERT INTO business_events(tenant_id,event_type) VALUES ($1,'estimate.closing_recommendation_reviewed')", [tenantId], "anon" as never)).rejects.toBeTruthy();
  });

  // N + O + P — no outcomes, no approvals, no tool calls/customer actions
  // result from recording review or follow-through evidence.
  it("N/O/P: recording review and follow-through creates no outcome, approval, tool call, or agent run", async () => {
    await reviewReq(recommendationEventId, validReviewBody);
    await followThroughReq(recommendationEventId, validFollowThroughBody(randomUUID()));
    for (const table of ["outcomes", "approvals", "tool_calls", "agent_runs"]) {
      expect((await rows(table)).rows).toHaveLength(0);
    }
  });

  // Q — the existing Estimate Sent event adapter (the accepted precedent
  // this hotfix's design mirrors) is unaffected by this change.
  it("Q: the existing estimate.sent event adapter is unaffected by this hotfix", async () => {
    await getPgTestPool().query("UPDATE leads SET status='New', estimate_amount=0 WHERE id=$1", [leadId]);
    await getPgTestPool().query(
      "INSERT INTO estimate_followup_sequences(tenant_id,lead_id,estimate_sent_at,day1_due_at,day3_due_at,day7_due_at) VALUES ($1,$2,now(),now()+interval '1 day',now()+interval '3 days',now()+interval '7 days')",
      [tenantId, leadId]
    );
    await getPgTestPool().query("UPDATE leads SET status='Estimate Sent', estimate_amount=500 WHERE id=$1", [leadId]);
    await emitEstimateSentEvent({ tenantId, leadId, estimateAmount: 500, sequenceCreated: false, actorUserId: actor.userId });
    const events = (await rows("business_events")).rows.filter((e) => e.event_type === "estimate.sent");
    expect(events).toHaveLength(1);
  });

  // R — recommendation generation is untouched: review/follow-through
  // continue to correctly require and read the SAME recommendation-
  // generated event shape every test above already depends on; explicitly
  // confirm a non-recommendation event is rejected as the wrong type.
  it("R: a recommendation-generation-shaped event is required — a differently-typed event id is rejected", async () => {
    const wrongTypeId = randomUUID();
    await getPgTestPool().query("INSERT INTO public.business_events (id, tenant_id, event_type, entity_type, entity_id) VALUES ($1,$2,'estimate.stalled','lead',$3)", [wrongTypeId, tenantId, leadId]);
    const r = await reviewReq(wrongTypeId, validReviewBody);
    expect(r.status).toBe(404);
  });
});

afterAll(async () => {
  if (getPgTestUrl()) await getPgTestPool().end();
});
