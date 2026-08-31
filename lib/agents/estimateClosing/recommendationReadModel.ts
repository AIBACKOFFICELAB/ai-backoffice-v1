import { BusinessEventStore, SupabaseBusinessEventStore } from "@/lib/events/store";
import { BusinessEvent } from "@/lib/events/types";
import {
  ESTIMATE_CLOSING_REASON_CODES,
  EstimateClosingReasonCode,
  EstimateClosingRecommendationType,
  SuggestedChannel,
  SuggestedTiming,
  SUGGESTED_TIMINGS,
} from "./types";

/**
 * P1 Sprint 2 — the dedicated read model for shadow recommendations. Reads
 * ONLY `estimate.closing_recommendation_generated` business events and
 * converts their persisted, privacy-safe payload (see
 * shadowRunner.ts::triggerEstimateClosingShadow, the only writer) into a
 * typed, UI-ready shape. Every page that shows a recommendation
 * (/agentic, /dashboard) goes through this module — nothing parses a raw
 * business_event payload directly anywhere else.
 *
 * Payload validation, not trust: a business_events row is free-text JSONB
 * at the database layer (see lib/events/types.ts's KNOWN_EVENT_TYPES
 * comment) — this module never assumes historical or hand-edited data
 * matches the current EstimateClosingRecommendation shape. A malformed
 * payload is skipped, counted, and never crashes a page (see
 * ListEstimateClosingRecommendationsResult.skippedMalformed).
 *
 * Bounded, not "load everything": listEstimateClosingRecommendations takes
 * a single bounded read (DEFAULT_LIMIT below), the same discipline
 * lib/dashboard/revenueCommandCenter.ts already applies to its own
 * recent-activity feeds (RECENT_ACTIVITY_LIMIT/RECENT_RUNS_LIMIT). This is
 * NOT a lifetime aggregate the way OutcomeStore.sumDirectAttributionValue()
 * is (that required a real database SUM() function — migration 021 —
 * founder-authorized specifically because it backs a headline dollar
 * figure). The metrics this read model's summary produces
 * (estimatesAnalyzed, opportunityValueAnalyzed, etc.) are honestly a
 * "most recent DEFAULT_LIMIT recommendations" figure, not a claimed
 * lifetime total — see the doc comment on
 * EstimateClosingRecommendationSummary. If real usage ever needs a true
 * lifetime total here, that is a genuine schema decision to bring back to
 * the founder (per the P1 Sprint 2 directive's Database Rule), not
 * something to quietly approximate by raising this bound indefinitely.
 */

const DEFAULT_LIMIT = 200;

export type EstimateClosingRecommendationView = {
  recommendationEventId: string;
  agentRunId: string | null;
  leadId: string | null;
  sequenceId: string | null;
  occurredAt: string;
  recommendation: EstimateClosingRecommendationType;
  confidence: number;
  reasonCodes: EstimateClosingReasonCode[];
  suggestedChannel: SuggestedChannel;
  suggestedTiming: SuggestedTiming;
  opportunityValue: number | null;
  /** Always "shadow" today — carried explicitly, not inferred, so the UI
   * never has to guess and so a future non-shadow recommendation source
   * (there isn't one) couldn't silently render as if it were this one. */
  mode: "shadow";
};

export type ListEstimateClosingRecommendationsResult = {
  recommendations: EstimateClosingRecommendationView[];
  /** Count of `estimate.closing_recommendation_generated` events read in
   * this call whose payload did NOT match the expected shape and were
   * therefore excluded — surfaced so a caller/page can show a sanitized
   * "N records could not be displayed" note instead of silently hiding
   * data loss, without ever rendering the malformed payload itself. */
  skippedMalformed: number;
};

const RECOMMENDATION_VALUES = new Set<EstimateClosingRecommendationType>(["follow_up", "wait", "owner_review"]);
const CHANNEL_VALUES = new Set<SuggestedChannel>(["sms", "email", "phone", "none"]);
const REASON_CODE_VALUES = new Set<string>(ESTIMATE_CLOSING_REASON_CODES);
const TIMING_VALUES = new Set<string>(SUGGESTED_TIMINGS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict shape check against the PERSISTED recommendation payload contract
 * (EstimateClosingRecommendation + agentRunId/sequenceId — see
 * shadowRunner.ts's emitEvent call). Deliberately distinct from
 * modelContract.ts::validateEstimateClosingModelOutput, which validates the
 * MODEL's raw JSON text (a different shape entirely — it has `rationale`,
 * this has `rationaleLength`; that one has no `opportunityValue`, this one
 * does). Exported for direct unit testing.
 */
export function parsePersistedRecommendationPayload(
  payload: unknown
):
  | {
      ok: true;
      value: {
        agentRunId: string | null;
        sequenceId: string | null;
        recommendation: EstimateClosingRecommendationType;
        confidence: number;
        reasonCodes: EstimateClosingReasonCode[];
        suggestedChannel: SuggestedChannel;
        suggestedTiming: SuggestedTiming;
        opportunityValue: number | null;
      };
    }
  | { ok: false } {
  if (!isRecord(payload)) return { ok: false };

  if (typeof payload.recommendation !== "string" || !RECOMMENDATION_VALUES.has(payload.recommendation as EstimateClosingRecommendationType)) {
    return { ok: false };
  }
  if (typeof payload.confidence !== "number" || !Number.isFinite(payload.confidence) || payload.confidence < 0 || payload.confidence > 1) {
    return { ok: false };
  }
  if (!Array.isArray(payload.reasonCodes) || payload.reasonCodes.some((c) => typeof c !== "string" || !REASON_CODE_VALUES.has(c))) {
    return { ok: false };
  }
  if (typeof payload.suggestedChannel !== "string" || !CHANNEL_VALUES.has(payload.suggestedChannel as SuggestedChannel)) {
    return { ok: false };
  }
  if (payload.suggestedTiming !== null && (typeof payload.suggestedTiming !== "string" || !TIMING_VALUES.has(payload.suggestedTiming))) {
    return { ok: false };
  }
  // opportunityValue, whenever present, is always the estimate's own
  // stored amount at write time (shadowRunner.ts:
  // opportunityValue: lead.estimateAmount) — and eligibility.ts's
  // no_estimate_value gate already guarantees that amount is > 0 for
  // every estimate a recommendation could ever be generated for. A
  // zero/negative value here cannot be a genuine recommendation; it can
  // only be corrupted/hand-edited data, and must be excluded rather than
  // summed into the displayed opportunity metric (Codex review finding
  // on PR #20).
  if (payload.opportunityValue !== null && (typeof payload.opportunityValue !== "number" || !Number.isFinite(payload.opportunityValue) || payload.opportunityValue <= 0)) {
    return { ok: false };
  }
  if (payload.agentRunId !== undefined && payload.agentRunId !== null && typeof payload.agentRunId !== "string") {
    return { ok: false };
  }
  if (payload.sequenceId !== undefined && payload.sequenceId !== null && typeof payload.sequenceId !== "string") {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      agentRunId: typeof payload.agentRunId === "string" ? payload.agentRunId : null,
      sequenceId: typeof payload.sequenceId === "string" ? payload.sequenceId : null,
      recommendation: payload.recommendation as EstimateClosingRecommendationType,
      confidence: payload.confidence as number,
      reasonCodes: payload.reasonCodes as EstimateClosingReasonCode[],
      suggestedChannel: payload.suggestedChannel as SuggestedChannel,
      suggestedTiming: (payload.suggestedTiming ?? null) as SuggestedTiming,
      opportunityValue: (payload.opportunityValue ?? null) as number | null,
    },
  };
}

function toView(event: BusinessEvent): EstimateClosingRecommendationView | null {
  const parsed = parsePersistedRecommendationPayload(event.payload);
  if (!parsed.ok) return null;
  return {
    recommendationEventId: event.id,
    agentRunId: parsed.value.agentRunId,
    leadId: event.entityId,
    sequenceId: parsed.value.sequenceId,
    occurredAt: event.occurredAt,
    recommendation: parsed.value.recommendation,
    confidence: parsed.value.confidence,
    reasonCodes: parsed.value.reasonCodes,
    suggestedChannel: parsed.value.suggestedChannel,
    suggestedTiming: parsed.value.suggestedTiming,
    opportunityValue: parsed.value.opportunityValue,
    mode: "shadow",
  };
}

/**
 * Reads ONLY estimate.closing_recommendation_generated events for this
 * tenant, bounded, most-recent-first (matches
 * SupabaseBusinessEventStore.listByTenant's own ordering). Every lookup is
 * tenant-scoped through the underlying store — never a cross-tenant read.
 */
export async function listEstimateClosingRecommendations(
  tenantId: string,
  options: { limit?: number; eventStore?: BusinessEventStore } = {}
): Promise<ListEstimateClosingRecommendationsResult> {
  const eventStore = options.eventStore ?? new SupabaseBusinessEventStore();
  const limit = options.limit ?? DEFAULT_LIMIT;

  const events = await eventStore.listByTenant(tenantId, {
    eventType: "estimate.closing_recommendation_generated",
    limit,
  });

  const recommendations: EstimateClosingRecommendationView[] = [];
  let skippedMalformed = 0;
  for (const event of events) {
    const view = toView(event);
    if (view) {
      recommendations.push(view);
    } else {
      skippedMalformed += 1;
    }
  }

  return { recommendations, skippedMalformed };
}

/**
 * Ranks recommendations for a small, bounded card display (both
 * /dashboard and /agentic use this): actionable recommendations
 * (follow_up, owner_review) surface before "wait" ones, and within each
 * group, higher opportunity value comes first (a recommendation with no
 * value sorts last within its group), with recency as the final
 * tiebreaker. Plain most-recent-first slicing could hide an older
 * high-value follow_up behind several newer, lower-priority wait
 * recommendations — which defeats the "highest-value/recent actionable
 * recommendations" goal the P1 Sprint 2 directive states explicitly
 * (Codex review finding on PR #20). Pure — takes the already-fetched view
 * list, does not re-fetch or re-sort the caller's own array in place.
 */
export function selectFeaturedRecommendations(
  recommendations: EstimateClosingRecommendationView[],
  limit: number
): EstimateClosingRecommendationView[] {
  const actionabilityRank = (r: EstimateClosingRecommendationView) => (r.recommendation === "wait" ? 1 : 0);
  return [...recommendations]
    .sort((a, b) => {
      const rankDiff = actionabilityRank(a) - actionabilityRank(b);
      if (rankDiff !== 0) return rankDiff;
      const valueDiff = (b.opportunityValue ?? -Infinity) - (a.opportunityValue ?? -Infinity);
      if (valueDiff !== 0) return valueDiff;
      return b.occurredAt.localeCompare(a.occurredAt);
    })
    .slice(0, limit);
}

export type EstimateClosingRecommendationSummary = {
  /** How many of the (bounded) recommendations read were considered —
   * "estimates analyzed by AI" in the UI. Reflects the same bounded window
   * as `recommendations` itself, not a lifetime count — see this module's
   * top-level doc comment. */
  estimatesAnalyzed: number;
  /** Sum of opportunityValue across that same bounded window. An
   * observation/recommendation metric ONLY — never a claim of recovered or
   * won revenue (see OUTCOME_ATTRIBUTION.md; only OutcomeStore's
   * direct-attribution figures are ever labeled "recovered"). */
  opportunityValueAnalyzed: number;
  followUpCount: number;
  waitCount: number;
  ownerReviewCount: number;
  latestRecommendationAt: string | null;
};

/** Pure — takes the already-fetched, already-validated view list so it is
 * trivially unit-testable without a store. */
export function summarizeEstimateClosingRecommendations(recommendations: EstimateClosingRecommendationView[]): EstimateClosingRecommendationSummary {
  let opportunityValueAnalyzed = 0;
  let followUpCount = 0;
  let waitCount = 0;
  let ownerReviewCount = 0;
  let latestRecommendationAt: string | null = null;

  for (const rec of recommendations) {
    if (rec.opportunityValue != null) opportunityValueAnalyzed += rec.opportunityValue;
    if (rec.recommendation === "follow_up") followUpCount += 1;
    else if (rec.recommendation === "wait") waitCount += 1;
    else if (rec.recommendation === "owner_review") ownerReviewCount += 1;
    if (latestRecommendationAt == null || rec.occurredAt > latestRecommendationAt) {
      latestRecommendationAt = rec.occurredAt;
    }
  }

  return {
    estimatesAnalyzed: recommendations.length,
    opportunityValueAnalyzed,
    followUpCount,
    waitCount,
    ownerReviewCount,
    latestRecommendationAt,
  };
}
