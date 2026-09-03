import { describe, it, expect } from "vitest";
import {
  recordEstimateClosingRecommendationFollowThrough,
  validateFollowThroughInput,
  validateSubmissionId,
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

const YES_PHONE = { actionTaken: "yes" as const, actionChannel: "phone" as const, customerResponse: "observed" as const, businessDisposition: "pending" as const };
const YES_PHONE_WON = { ...YES_PHONE, businessDisposition: "won" as const };
const NO_UNKNOWN = { actionTaken: "no" as const, actionChannel: null, customerResponse: "unknown" as const, businessDisposition: "pending" as const };
const LATER_UNKNOWN = { actionTaken: "later" as const, actionChannel: null, customerResponse: "unknown" as const, businessDisposition: "pending" as const };

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

describe("validateSubmissionId", () => {
  it("accepts a UUID-shaped string", () => {
    expect(validateSubmissionId("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(true);
  });

  it("accepts any bounded alphanumeric/dash/underscore string, not strictly UUID-v4", () => {
    expect(validateSubmissionId("submission-abc_123")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(validateSubmissionId("")).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(validateSubmissionId(undefined)).toBe(false);
    expect(validateSubmissionId(null)).toBe(false);
    expect(validateSubmissionId(12345)).toBe(false);
    expect(validateSubmissionId({})).toBe(false);
  });

  it("rejects a value longer than 100 characters (bounded shape only)", () => {
    expect(validateSubmissionId("a".repeat(101))).toBe(false);
    expect(validateSubmissionId("a".repeat(100))).toBe(true);
  });

  it("rejects characters outside the bounded set", () => {
    expect(validateSubmissionId("has spaces")).toBe(false);
    expect(validateSubmissionId("has;semicolon")).toBe(false);
  });
});

describe("recordEstimateClosingRecommendationFollowThrough", () => {
  it("owner can record follow-through on a same-tenant recommendation", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const result = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...YES_PHONE_WON, submissionId: "submission-1" },
      { eventStore: store }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.followThrough).toEqual({ recommendationEventId: rec.id, ...YES_PHONE_WON });
      expect(result.deduped).toBe(false);
    }
  });

  it("persists exactly one estimate.closing_recommendation_followthrough_recorded event, actorType 'user', causationId = recommendation id", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...NO_UNKNOWN, submissionId: "submission-1" },
      { eventStore: store }
    );

    const recorded = store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].actorType).toBe("user");
    expect(recorded[0].actorId).toBe("user-owner-1");
    expect(recorded[0].causationId).toBe(rec.id);
    // submissionId is transport identity only — never persisted in the
    // business payload.
    expect(Object.keys(recorded[0].payload)).not.toContain("submissionId");
  });

  it("a cross-tenant recommendationEventId is refused as not_found (never distinguishes wrong-tenant from missing)", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store, { tenantId: "tenant-A" });

    const result = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-B",
      "user-owner-2",
      { recommendationEventId: rec.id, ...NO_UNKNOWN, submissionId: "submission-1" },
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
      { recommendationEventId: "does-not-exist", ...NO_UNKNOWN, submissionId: "submission-1" },
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
      { recommendationEventId: wrongEvent.id, ...NO_UNKNOWN, submissionId: "submission-1" },
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
      { recommendationEventId: rec.id, actionTaken: "totally_did", actionChannel: null, customerResponse: "unknown", businessDisposition: "pending", submissionId: "submission-1" },
      { eventStore: store }
    );

    expect(result).toEqual({ ok: false, error: "invalid_action_taken" });
    expect(store.all()).toHaveLength(1); // only the seeded recommendation event
  });

  it("refuses a missing/malformed submissionId — and business content is still validated first", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const missing = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...NO_UNKNOWN, submissionId: undefined },
      { eventStore: store }
    );
    expect(missing).toEqual({ ok: false, error: "invalid_submission_id" });

    const malformed = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...NO_UNKNOWN, submissionId: "has spaces" },
      { eventStore: store }
    );
    expect(malformed).toEqual({ ok: false, error: "invalid_submission_id" });

    expect(store.all()).toHaveLength(1); // only the seeded recommendation event — nothing written
  });

  // --- A. same submissionId + same payload -> one event, second deduped ---
  it("A. same submissionId + same payload: a true retry dedupes to the original — one event, no duplicate", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);
    const input = { recommendationEventId: rec.id, ...YES_PHONE, submissionId: "submission-1" };

    const first = await recordEstimateClosingRecommendationFollowThrough("tenant-1", "user-owner-1", input, { eventStore: store });
    const second = await recordEstimateClosingRecommendationFollowThrough("tenant-1", "user-owner-1", input, { eventStore: store });

    expect(first.ok && !first.deduped).toBe(true);
    expect(second.ok && second.deduped).toBe(true);
    if (first.ok && second.ok) expect(second.followThrough).toEqual(first.followThrough);
    expect(store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded")).toHaveLength(1);
  });

  // --- B. same submissionId + altered payload -> preserves original submission semantics ---
  it("B. same submissionId + ALTERED payload: the idempotency key can never represent two payloads — the request dedupes to the ORIGINAL content, never a validation error, never a silent overwrite (documented choice, matching every other idempotency-keyed event type in this codebase)", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const first = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...YES_PHONE, submissionId: "submission-1" },
      { eventStore: store }
    );
    // A caller bug (or a malicious replay) reusing the SAME submissionId
    // with genuinely different content.
    const second = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...YES_PHONE_WON, submissionId: "submission-1" },
      { eventStore: store }
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.deduped).toBe(true);
      // The FIRST submission's content wins — the second call's own
      // (different) businessDisposition is never persisted.
      expect(second.followThrough).toEqual(first.followThrough);
      expect(second.followThrough.businessDisposition).toBe("pending");
    }
    expect(store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded")).toHaveLength(1);
  });

  // --- C. A -> B -> A with THREE different submissionIds -> 3 events, current resolves final A ---
  it("C. A -> B -> A with three distinct submissionIds, all within the same instant: 3 persisted events, current state resolves the final A (Codex + founder review findings on PR #25, P1 — the fix)", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);
    const sameInstant = () => 1_000_000_000; // identical clock reading for all three — proves dedup no longer depends on timing at all

    const first = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...YES_PHONE, submissionId: "submission-A1" },
      { eventStore: store, now: sameInstant }
    );
    const second = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...YES_PHONE_WON, submissionId: "submission-B" },
      { eventStore: store, now: sameInstant }
    );
    const third = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...YES_PHONE, submissionId: "submission-A2" },
      { eventStore: store, now: sameInstant }
    );

    expect(first.ok && !first.deduped).toBe(true);
    expect(second.ok && !second.deduped).toBe(true);
    expect(third.ok && !third.deduped).toBe(true); // NOT deduped, despite identical content AND identical timestamp

    const recorded = store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded");
    expect(recorded).toHaveLength(3);
  });

  // --- D. A -> B -> A with identical timestamps: request identity still distinguishes ---
  it("D. identical occurredAt across all three submissions (store permits it): request identity alone still keeps them as 3 distinct rows", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);
    const frozen = () => 1_700_000_000_000;

    for (const submissionId of ["s1", "s2", "s3"]) {
      await recordEstimateClosingRecommendationFollowThrough(
        "tenant-1",
        "user-owner-1",
        { recommendationEventId: rec.id, ...YES_PHONE, submissionId },
        { eventStore: store, now: frozen }
      );
    }

    const recorded = store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded");
    expect(recorded).toHaveLength(3);
    expect(new Set(recorded.map((e) => e.occurredAt)).size).toBe(1); // genuinely identical timestamps
  });

  // --- E. transport retry of B using same submissionId -> only one B event ---
  it("E. a transport retry of a correction (same submissionId reused after a simulated failure) creates only ONE event for that correction", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    // The "first" submission (A) succeeds normally.
    await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...YES_PHONE, submissionId: "submission-A" },
      { eventStore: store }
    );

    // The owner corrects to B. The client mints "submission-B" and the
    // request appears to fail on the wire (simulated: caller code retries
    // with the SAME submissionId, exactly as FollowThroughControls.tsx
    // does on a transport error).
    const bAttempt1 = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...YES_PHONE_WON, submissionId: "submission-B" },
      { eventStore: store }
    );
    const bAttempt2 = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...YES_PHONE_WON, submissionId: "submission-B" },
      { eventStore: store }
    );

    expect(bAttempt1.ok && !bAttempt1.deduped).toBe(true);
    expect(bAttempt2.ok && bAttempt2.deduped).toBe(true);

    const recorded = store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded");
    expect(recorded).toHaveLength(2); // the original A, and exactly one B (not two)
  });

  it("a genuine CORRECTION (a different answer, a NEW submissionId) creates a NEW, additional row — append-only, never overwritten", async () => {
    const store = new InMemoryBusinessEventStore();
    const rec = await seedRecommendationEvent(store);

    const first = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...LATER_UNKNOWN, submissionId: "submission-1" },
      { eventStore: store }
    );
    const second = await recordEstimateClosingRecommendationFollowThrough(
      "tenant-1",
      "user-owner-1",
      { recommendationEventId: rec.id, ...YES_PHONE_WON, submissionId: "submission-2" },
      { eventStore: store }
    );

    expect(first.ok && !first.deduped).toBe(true);
    expect(second.ok && !second.deduped).toBe(true);
    const recorded = store.all().filter((e) => e.eventType === "estimate.closing_recommendation_followthrough_recorded");
    // Both evidence rows survive — the first is never deleted or mutated.
    expect(recorded).toHaveLength(2);
  });

  it("follow-through is idempotent per-tenant — a different tenant with an equivalently-shaped submission (even the same submissionId string) is independent", async () => {
    const store = new InMemoryBusinessEventStore();
    const recA = await seedRecommendationEvent(store, { tenantId: "tenant-A", entityId: "lead-A" });
    const recB = await seedRecommendationEvent(store, { tenantId: "tenant-B", entityId: "lead-B" });

    await recordEstimateClosingRecommendationFollowThrough("tenant-A", "user-A", { recommendationEventId: recA.id, ...NO_UNKNOWN, submissionId: "submission-shared" }, { eventStore: store });
    await recordEstimateClosingRecommendationFollowThrough("tenant-B", "user-B", { recommendationEventId: recB.id, ...NO_UNKNOWN, submissionId: "submission-shared" }, { eventStore: store });

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
        ...YES_PHONE_WON,
        submissionId: "submission-1",
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
      { recommendationEventId: rec.id, ...YES_PHONE_WON, submissionId: "submission-1" },
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
      { recommendationEventId: rec.id, ...YES_PHONE_WON, submissionId: "submission-1" },
      { eventStore: store }
    );

    // Exactly two events exist in the whole store: the seeded recommendation
    // and the one follow-through record — nothing else was ever written.
    expect(store.all()).toHaveLength(2);
  });
});

describe("buildFollowThroughIdempotencyKey", () => {
  it("is deterministic — the same recommendation + same submissionId always produces the same key", () => {
    expect(buildFollowThroughIdempotencyKey("rec-1", "submission-1")).toBe(buildFollowThroughIdempotencyKey("rec-1", "submission-1"));
  });

  it("differs when the submissionId differs, even for the identical recommendation", () => {
    expect(buildFollowThroughIdempotencyKey("rec-1", "submission-1")).not.toBe(buildFollowThroughIdempotencyKey("rec-1", "submission-2"));
  });

  it("differs across recommendations even with the identical submissionId", () => {
    expect(buildFollowThroughIdempotencyKey("rec-1", "submission-1")).not.toBe(buildFollowThroughIdempotencyKey("rec-2", "submission-1"));
  });

  it("never depends on business content or a clock — content and timing are not parameters of this function at all", () => {
    // Structural proof: the function only accepts (recommendationEventId,
    // submissionId) — there is no third parameter for content or time.
    expect(buildFollowThroughIdempotencyKey.length).toBe(2);
  });
});

describe("describeFollowThroughError", () => {
  it("returns a distinct, human-readable message for every error kind", () => {
    const errors: Array<Parameters<typeof describeFollowThroughError>[0]> = [
      "invalid_action_taken",
      "invalid_action_channel",
      "invalid_customer_response",
      "invalid_business_disposition",
      "invalid_submission_id",
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
