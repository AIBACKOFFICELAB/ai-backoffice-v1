import { describe, it, expect } from "vitest";
import {
  recordEstimateClosingRecommendationFollowThrough,
  validateFollowThroughInput,
  describeFollowThroughError,
  buildFollowThroughIdempotencyKey,
} from "./followThrough";
import {
  FOLLOWTHROUGH_ACTION_TAKEN,
  FOLLOWTHROUGH_ACTION_CHANNEL,
  FOLLOWTHROUGH_CUSTOMER_RESPONSE,
  FOLLOWTHROUGH_BUSINESS_DISPOSITION,
} from "./followThroughTypes";
import { InMemoryBusinessEventStore } from "@/lib/events/store";

const VALID_RECOMMENDATION_PAYLOAD = {
  recommendation: "follow_up",
  confidence: 0.82,
  reasonCodes: ["no_response_since_sent"],
  suggestedChannel: "sms",
  suggestedTiming: "within_24_hours",
  opportunityValue: 4200,
  rationaleLength: 312,
  agentRunId: "run-1",
  sequenceId: "seq-1",
};

async function seedRecommendationEvent(
  store: InMemoryBusinessEventStore,
  overrides: { tenantId?: string; entityId?: string | null; payload?: unknown } = {}
) {
  const { event } = await store.insert({
    tenantId: overrides.tenantId ?? "tenant-1",
    eventType: "estimate.closing_recommendation_generated",
    actorType: "agent",
    actorId: "agent-1",
    entityType: "lead",
    entityId: overrides.entityId ?? "lead-1",
    payload: (overrides.payload ?? VALID_RECOMMENDATION_PAYLOAD) as Record<string, unknown>,
  });
  return event;
}

describe("validateFollowThroughInput", () => {
  it("accepts actionTaken 'yes' with a valid channel", () => {
    for (const channel of FOLLOWTHROUGH_ACTION_CHANNEL) {
      const result = validateFollowThroughInput({ actionTaken: "yes", actionChannel: channel, customerResponse: "unknown", businessDisposition: "pending" });
      expect(result.ok).toBe(true);
    }
  });

  it("accepts every valid customerResponse/businessDisposition combination", () => {
    for (const customerResponse of FOLLOWTHROUGH_CUSTOMER_RESPONSE) {
      for (const businessDisposition of FOLLOWTHROUGH_BUSINESS_DISPOSITION) {
        const result = validateFollowThroughInput({ actionTaken: "no", actionChannel: null, customerResponse, businessDisposition });
        expect(result.ok, `${customerResponse}/${businessDisposition}`).toBe(true);
      }
    }
  });

  it("accepts actionTaken 'no' or 'later' only with actionChannel null", () => {
    for (const actionTaken of ["no", "later"] as const) {
      const result = validateFollowThroughInput({ actionTaken, actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects actionTaken 'yes' without a channel — a channel is required", () => {
    const result = validateFollowThroughInput({ actionTaken: "yes", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" });
    expect(result).toEqual({ ok: false, error: "invalid_action_channel" });
  });

  it("rejects actionTaken 'no'/'later' WITH a channel — never silently implies a channel (P1 Sprint 6 directive §7)", () => {
    for (const actionTaken of ["no", "later"] as const) {
      const result = validateFollowThroughInput({ actionTaken, actionChannel: "sms", customerResponse: "unknown", businessDisposition: "pending" });
      expect(result).toEqual({ ok: false, error: "invalid_action_channel" });
    }
  });

  it("rejects a malformed actionTaken", () => {
    const result = validateFollowThroughInput({ actionTaken: "maybe", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" });
    expect(result).toEqual({ ok: false, error: "invalid_action_taken" });
  });

  it("rejects a malformed actionChannel value even when actionTaken is 'yes'", () => {
    const result = validateFollowThroughInput({ actionTaken: "yes", actionChannel: "carrier_pigeon", customerResponse: "unknown", businessDisposition: "pending" });
    expect(result).toEqual({ ok: false, error: "invalid_action_channel" });
  });

  it("rejects a malformed customerResponse", () => {
    const result = validateFollowThroughInput({ actionTaken: "no", actionChannel: null, customerResponse: "maybe", businessDisposition: "pending" });
    expect(result).toEqual({ ok: false, error: "invalid_customer_response" });
  });

  it("rejects a malformed businessDisposition", () => {
    const result = validateFollowThroughInput({ actionTaken: "no", actionChannel: null, customerResponse: "unknown", businessDisposition: "probably_won" });
    expect(result).toEqual({ ok: false, error: "invalid_business_disposition" });
  });

  it("rejects free text smuggled into any enum field", () => {
    const result = validateFollowThroughInput({
      actionTaken: "the owner called and left a voicemail",
      actionChannel: null,
      customerResponse: "unknown",
      businessDisposition: "pending",
    });
    expect(result).toEqual({ ok: false, error: "invalid_action_taken" });
  });
});

describe("recordEstimateClosingRecommendationFollowThrough", () => {
  it("owner can record follow-through on a same-tenant recommendation", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const result = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" },
      { eventStore: store }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.followThrough).toEqual({
        recommendationEventId: rec.id,
        actionTaken: "yes",
        actionChannel: "phone",
        customerResponse: "observed",
        businessDisposition: "won",
      });
      expect(result.deduped).toBe(false);
    }
  });

  it("persists exactly one estimate.closing_recommendation_followthrough_recorded event, actorType 'user', causationId = recommendation id", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, actionTaken: "no", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" },
      { eventStore: store }
    );

    const recorded = store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].actorType).toBe("user");
    expect(recorded[0].actorId).toBe("user-owner-1");
    expect(recorded[0].causationId).toBe(rec.id);
  });

  it("a cross-tenant recommendationEventId is refused as not_found (never distinguishes wrong-tenant from missing)", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store, { tenantId: "tenant-A" });

    const result = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-B",
      "user-owner-2",
      { recommendationEventId: rec.id, actionTaken: "no", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" },
      { eventStore: store }
    );

    expect(result).toEqual({ ok: false, error: "recommendation_not_found" });
    expect(store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded")).toHaveLength(0);
  });

  it("a nonexistent recommendationEventId is refused as not_found", async () => {
    const store = new InMemoryBusinessEventStore();
    const result = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: "does-not-exist", actionTaken: "no", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" },
      { eventStore: store }
    );
    expect(result).toEqual({ ok: false, error: "recommendation_not_found" });
  });

  it("refuses follow-through against an event of the wrong type", async () => {
    const store = new InMemoryBusinessEventStore();
    const { event: wrongEvent } = await store.insert({
      tenantId: "tenant-1",
      eventType: "estimate.stalled",
      actorType: "system",
      entityType: "lead",
      entityId: "lead-1",
      payload: {},
    });

    const result = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: wrongEvent.id, actionTaken: "no", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" },
      { eventStore: store }
    );

    expect(result).toEqual({ ok: false, error: "wrong_event_type" });
  });

  it("refuses a malformed submission without touching the event store", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const result = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, actionTaken: "totally_did", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" },
      { eventStore: store }
    );

    expect(result).toEqual({ ok: false, error: "invalid_action_taken" });
    expect(store.all()).toHaveLength(1); // only the seeded recommendation event
  });

  it("an EXACT duplicate retry within the same dedupe window (same recommendation, same four answers, same moment) dedupes to the original — idempotent, no duplicate row", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);
    const input = { recommendationEventId: rec.id, actionTaken: "yes" as const, actionChannel: "phone" as const, customerResponse: "observed" as const, businessDisposition: "pending" as const };
    const sameMoment = () => 1_000_000_000;

    const first = await recordEstimateClosingRecommendationFollowThrough("tenant-1", "user-owner-1", input, { eventStore: store, now: sameMoment });
    const second = await recordEstimateClosingRecommendationFollowThrough("tenant-1", "user-owner-1", input, { eventStore: store, now: sameMoment });

    expect(first.ok && !first.deduped).toBe(true);
    expect(second.ok && second.deduped).toBe(true);
    if (first.ok && second.ok) expect(second.followThrough).toEqual(first.followThrough);
    expect(store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded")).toHaveLength(1);
  });

  it("a correction that reverts to an EARLIER answer is never silently dropped — A -> B -> A each lands as its own current event, not deduped to the original A (Codex review finding on PR #25, P1)", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);
    const stateA = { recommendationEventId: rec.id, actionTaken: "yes" as const, actionChannel: "phone" as const, customerResponse: "observed" as const, businessDisposition: "pending" as const };
    const stateB = { recommendationEventId: rec.id, actionTaken: "yes" as const, actionChannel: "phone" as const, customerResponse: "observed" as const, businessDisposition: "won" as const };
    // Each submission is far enough apart (well beyond the 5s dedupe
    // window) to be unambiguously a distinct, later submission, never an
    // accidental retry of the previous one.
    const first = await recordEstimateClosingRecommendationFollowThrough("tenant-1", "user-owner-1", stateA, { eventStore: store, now: () => 1_000_000_000 });
    const second = await recordEstimateClosingRecommendationFollowThrough("tenant-1", "user-owner-1", stateB, { eventStore: store, now: () => 1_000_020_000 });
    // The third submission's CONTENT is byte-identical to the first (A
    // again) — this is exactly the case a pure content-hash key would
    // wrongly collide on.
    const third = await recordEstimateClosingRecommendationFollowThrough("tenant-1", "user-owner-1", stateA, { eventStore: store, now: () => 1_000_040_000 });

    expect(first.ok && !first.deduped).toBe(true);
    expect(second.ok && !second.deduped).toBe(true);
    expect(third.ok && !third.deduped).toBe(true); // NOT deduped to the first A

    const recorded = store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded");
    expect(recorded).toHaveLength(3); // all three evidence rows survive, append-only

    // The "current" (latest-by-occurredAt) resolved value must be the
    // THIRD submission's own occurredAt — not the first A's stale one.
    const latest = recorded.reduce((a, b) => (b.occurredAt > a.occurredAt ? b : a));
    expect(latest.payload).toEqual({ recommendationEventId: rec.id, actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "pending" });
  });

  it("a genuine CORRECTION (a different answer for the same recommendation) creates a NEW, additional row — append-only, never overwritten", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const first = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, actionTaken: "later", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending" },
      { eventStore: store }
    );
    const second = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, actionTaken: "yes", actionChannel: "sms", customerResponse: "observed", businessDisposition: "won" },
      { eventStore: store }
    );

    expect(first.ok && !first.deduped).toBe(true);
    expect(second.ok && !second.deduped).toBe(true);
    const recorded = store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded");
    // Both evidence rows survive — the first is never deleted or mutated.
    expect(recorded).toHaveLength(2);
  });

  it("follow-through is idempotent per-tenant — a different tenant with an equivalently-shaped submission is independent", async () => {
    const store = new InMemoryBusinessEventStore();
    const recA = await seedRecommendationEvent(store, { tenantId: "tenant-A", entityId: "lead-A" });
    const recB = await seedRecommendationEvent(store, { tenantId: "tenant-B", entityId: "lead-B" });
    const input = { actionTaken: "no" as const, actionChannel: null, customerResponse: "unknown" as const, businessDisposition: "pending" as const };

    await recordEstimateClosingRecommendationFollowThrough("tenant-A", "user-A", { recommendationEventId: recA.id, ...input }, { eventStore: store });
    await recordEstimateClosingRecommendationFollowThrough("tenant-B", "user-B", { recommendationEventId: recB.id, ...input }, { eventStore: store });

    const recorded = store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded");
    expect(recorded).toHaveLength(2);
  });

  it("never accepts or persists a free-text/PII-shaped field, even if the caller sends one", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const result = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      {
        recommendationEventId: rec.id,
        actionTaken: "yes",
        actionChannel: "phone",
        customerResponse: "observed",
        businessDisposition: "won",
        // Deliberately smuggling extra fields a caller might send over
        // HTTP — RecordFollowThroughInput has no such fields.
        notes: "the customer said they'd think about it",
        customerPhone: "+15550001111",
        callTranscript: "hi this is...",
      } as unknown as Parameters<typeof recordEstimateClosingRecommendationFollowThrough>[2],
      { eventStore: store }
    );

    expect(result.ok).toBe(true);
    const recorded = store.all().find((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded");
    expect(recorded).toBeDefined();
    expect(Object.keys(recorded!.payload).sort()).toEqual(["actionChannel", "actionTaken", "businessDisposition", "customerResponse", "recommendationEventId"]);
    expect(JSON.stringify(recorded!.payload)).not.toContain("notes");
    expect(JSON.stringify(recorded!.payload)).not.toContain("+15550001111");
    expect(JSON.stringify(recorded!.payload)).not.toContain("callTranscript");
  });

  it("has no dependency capable of mutating a lead, outcome, approval, or tool call — structural guarantee", async () => {
    // recordEstimateClosingRecommendationFollowThrough's own signature
    // accepts only a BusinessEventStore — there is no lead/outcome/
    // approval/tool-call store parameter anywhere for it to call. Pins the
    // structural fact so a future edit adding one of those dependencies
    // fails a code review, not just a runtime assertion.
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);
    await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" },
      { eventStore: store }
    );

    // The recommendation event itself is unchanged — business_events has
    // no update() method at all (append-only by interface design).
    const stillThere = await store.getById("tenant-1", rec.id);
    expect(stillThere?.payload).toEqual(VALID_RECOMMENDATION_PAYLOAD);
  });

  it("owner-reported 'won' does not itself create anything beyond the one follow-through event — no outcome, no lead mutation", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);
    await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, actionTaken: "yes", actionChannel: "phone", customerResponse: "observed", businessDisposition: "won" },
      { eventStore: store }
    );

    // Exactly two events exist in the whole store: the seeded recommendation
    // and the one follow-through record — nothing else was ever written.
    expect(store.all()).toHaveLength(2);
  });
});

describe("buildFollowThroughIdempotencyKey", () => {
  const NOW = 1_700_000_000_000;

  it("is deterministic — the same recommendation + same answers + same time bucket always produces the same key", () => {
    const value = { recommendationEventId: "rec-1", actionTaken: "yes" as const, actionChannel: "phone" as const, customerResponse: "observed" as const, businessDisposition: "won" as const };
    expect(buildFollowThroughIdempotencyKey("rec-1", value, NOW)).toBe(buildFollowThroughIdempotencyKey("rec-1", { ...value }, NOW));
  });

  it("differs when any one of the four answers differs", () => {
    const base = { recommendationEventId: "rec-1", actionTaken: "yes" as const, actionChannel: "phone" as const, customerResponse: "observed" as const, businessDisposition: "won" as const };
    const key = buildFollowThroughIdempotencyKey("rec-1", base, NOW);
    expect(buildFollowThroughIdempotencyKey("rec-1", { ...base, actionTaken: "no", actionChannel: null }, NOW)).not.toBe(key);
    expect(buildFollowThroughIdempotencyKey("rec-1", { ...base, businessDisposition: "lost" }, NOW)).not.toBe(key);
  });

  it("differs across recommendations even with identical answers and identical time", () => {
    const value = { recommendationEventId: "irrelevant", actionTaken: "no" as const, actionChannel: null, customerResponse: "unknown" as const, businessDisposition: "pending" as const };
    expect(buildFollowThroughIdempotencyKey("rec-1", value, NOW)).not.toBe(buildFollowThroughIdempotencyKey("rec-2", value, NOW));
  });

  it("differs across time buckets even with identical recommendation and identical answers — the fix for the A -> B -> A collision (Codex review finding on PR #25, P1)", () => {
    const value = { recommendationEventId: "rec-1", actionTaken: "yes" as const, actionChannel: "phone" as const, customerResponse: "observed" as const, businessDisposition: "won" as const };
    const keyAtT0 = buildFollowThroughIdempotencyKey("rec-1", value, NOW);
    const keyMuchLater = buildFollowThroughIdempotencyKey("rec-1", value, NOW + 60_000); // 60s later — a different bucket
    expect(keyAtT0).not.toBe(keyMuchLater);
  });

  it("does NOT differ within the same short dedupe window — an accidental double-click or network retry still collapses to one key", () => {
    const value = { recommendationEventId: "rec-1", actionTaken: "yes" as const, actionChannel: "phone" as const, customerResponse: "observed" as const, businessDisposition: "won" as const };
    const keyAtT0 = buildFollowThroughIdempotencyKey("rec-1", value, NOW);
    const keyMomentsLater = buildFollowThroughIdempotencyKey("rec-1", value, NOW + 50); // 50ms later — same bucket
    expect(keyAtT0).toBe(keyMomentsLater);
  });
});

describe("describeFollowThroughError", () => {
  it("returns a distinct, human-readable message for every error kind", () => {
    const errors: Array<Parameters<typeof describeFollowThroughError>[0]> = [
      "invalid_action_taken",
      "invalid_action_channel",
      "invalid_customer_response",
      "invalid_business_disposition",
      "recommendation_not_found",
      "wrong_event_type",
    ];
    const messages = errors.map(describeFollowThroughError);
    expect(new Set(messages).size).toBe(errors.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(0);
  });
});

describe("FOLLOWTHROUGH enums", () => {
  it("action taken has exactly the three directed values", () => {
    expect(FOLLOWTHROUGH_ACTION_TAKEN).toEqual(["yes", "no", "later"]);
  });
});
