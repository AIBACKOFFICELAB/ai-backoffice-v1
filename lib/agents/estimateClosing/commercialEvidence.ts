import { PlumbingLead } from "@/data/leadModel";
import { BusinessEventStore, SupabaseBusinessEventStore } from "@/lib/events/store";
import { BusinessEvent } from "@/lib/events/types";
import { getLeads } from "@/lib/leads/repository";
import {
  listEstimateClosingRecommendations,
  EstimateClosingRecommendationView,
} from "./recommendationReadModel";
import { listEstimateClosingRecommendationReviews, EstimateClosingRecommendationReviewView } from "./evaluationReadModel";
import {
  FollowThroughActionTaken,
  FollowThroughCustomerResponse,
  FollowThroughBusinessDisposition,
  EstimateClosingRecommendationFollowThrough,
  parsePersistedFollowThroughPayload,
} from "./followThroughTypes";

/**
 * P1 Sprint 6 — closes the "did the recommendation actually lead to
 * anything?" evidence gap. Reads recommendations (recommendationReadModel),
 * reviews (evaluationReadModel), owner-recorded follow-through (this
 * module's own event type), and current lead status — never reimplements
 * any of the first two, and never writes a canonical `outcomes` row (see
 * OUTCOME_ATTRIBUTION.md's "Follow-through is not an outcome" section).
 *
 * CONSTITUTIONAL ATTRIBUTION RULE (P1 Sprint 6 directive §3), enforced
 * throughout this module: AI recommendation != owner review != owner
 * action != customer response != estimate won != AI-caused revenue. No
 * stage automatically implies the next. Every count/state below is an
 * OBSERVATION, never a manufactured causal claim.
 */

const FOLLOWTHROUGH_EVENT_TYPE = "estimate.closing_recommendation_followthrough_recorded";

function latestByOccurredAt<T extends { occurredAt: string }>(items: T[]): T | null {
  if (items.length === 0) return null;
  return items.reduce((latest, current) => (current.occurredAt > latest.occurredAt ? current : latest));
}

/**
 * Groups a batch of (possibly multi-row, append-only-correction) follow-
 * through events by recommendationEventId (via causationId, the same
 * linkage review events use) and resolves each recommendation's CURRENT
 * follow-through as its most recent valid event — see followThrough.ts's
 * top-level doc comment for why "latest wins" is the chosen read
 * discipline. A malformed historical payload is skipped and counted, never
 * trusted. Pure — takes already-fetched events.
 */
export function resolveCurrentFollowThroughByRecommendation(
  events: Array<Pick<BusinessEvent, "causationId" | "occurredAt" | "payload">>
): { current: Map<string, { followThrough: EstimateClosingRecommendationFollowThrough; occurredAt: string }>; skippedMalformed: number } {
  const byRecommendation = new Map<string, Array<{ followThrough: EstimateClosingRecommendationFollowThrough; occurredAt: string }>>();
  let skippedMalformed = 0;

  for (const event of events) {
    if (!event.causationId) {
      skippedMalformed += 1;
      continue;
    }
    const parsed = parsePersistedFollowThroughPayload(event.payload);
    if (!parsed.ok) {
      skippedMalformed += 1;
      continue;
    }
    const list = byRecommendation.get(event.causationId) ?? [];
    list.push({ followThrough: parsed.value, occurredAt: event.occurredAt });
    byRecommendation.set(event.causationId, list);
  }

  const current = new Map<string, { followThrough: EstimateClosingRecommendationFollowThrough; occurredAt: string }>();
  for (const [recommendationEventId, records] of Array.from(byRecommendation)) {
    const latest = latestByOccurredAt(records);
    if (latest) current.set(recommendationEventId, latest);
  }

  return { current, skippedMalformed };
}

/** P1 Sprint 6 §13 — the pure evidence-state resolver for one
 * recommendation. Returns the furthest-reached EVIDENCE ladder rung
 * (RECOMMENDATION_RECORDED..BUSINESS_DISPOSITION_OBSERVED — each requires
 * everything before it) as a SEPARATE fact from `attributionStage`, which
 * this sprint hardcodes to "ATTRIBUTION_NOT_ESTABLISHED" regardless of how
 * far the evidence ladder progresses — no canonical outcome writer exists
 * yet (see OUTCOME_ATTRIBUTION.md), so attribution itself can never be
 * established by this function no matter what evidence exists. A future
 * sprint that adds a real canonical-outcome path would widen
 * `AttributionStage` deliberately, not silently. */
export type EstimateClosingAttributionEvidenceStage =
  | "RECOMMENDATION_RECORDED"
  | "OWNER_REVIEW_RECORDED"
  | "OWNER_ACTION_RECORDED"
  | "CUSTOMER_RESPONSE_OBSERVED"
  | "BUSINESS_DISPOSITION_OBSERVED";

export type EstimateClosingAttributionState = {
  evidenceStage: EstimateClosingAttributionEvidenceStage;
  attributionStage: "ATTRIBUTION_NOT_ESTABLISHED";
};

export function resolveEstimateClosingAttributionState(input: {
  hasReview: boolean;
  actionTaken: FollowThroughActionTaken | null;
  customerResponse: FollowThroughCustomerResponse | null;
  businessDisposition: FollowThroughBusinessDisposition | null;
}): EstimateClosingAttributionState {
  let evidenceStage: EstimateClosingAttributionEvidenceStage = "RECOMMENDATION_RECORDED";
  if (input.hasReview) evidenceStage = "OWNER_REVIEW_RECORDED";
  if (input.actionTaken === "yes") evidenceStage = "OWNER_ACTION_RECORDED";
  if (input.actionTaken === "yes" && input.customerResponse === "observed") evidenceStage = "CUSTOMER_RESPONSE_OBSERVED";
  if (input.actionTaken === "yes" && input.businessDisposition != null && input.businessDisposition !== "unknown") {
    evidenceStage = "BUSINESS_DISPOSITION_OBSERVED";
  }
  // Always "ATTRIBUTION_NOT_ESTABLISHED" this sprint — see the doc comment
  // above. Never derived as DIRECT/ASSISTED/INFERRED from the follow-through
  // form (P1 Sprint 6 directive §13: "Those are outcome attribution
  // classifications, not UI enthusiasm levels").
  return { evidenceStage, attributionStage: "ATTRIBUTION_NOT_ESTABLISHED" };
}

/** P1 Sprint 6 §20 — commercial evidence diagnostics: useful
 * inconsistencies surfaced for the owner, never auto-corrected. */
export type CommercialEvidenceDiagnosticCode =
  | "disposition_lead_status_mismatch"
  | "followthrough_before_recommendation"
  | "response_observed_without_action";

export type CommercialEvidenceDiagnostic = {
  code: CommercialEvidenceDiagnosticCode;
  recommendationEventId: string;
};

export type EstimateClosingCommercialEvidence = {
  recommendationsGenerated: number;
  recommendationsReviewed: number;
  recommendationsAwaitingReview: number;
  /** How many (of the bounded window's) recommendations have ANY current
   * follow-through record — not "reviewed", a different question. */
  followthroughRecorded: number;
  actedYes: number;
  actedNo: number;
  actedLater: number;
  customerResponsesObserved: number;
  ownerReportedWon: number;
  ownerReportedLost: number;
  ownerReportedPending: number;
  recommendationsWithoutFollowthrough: number;
  /** followthroughRecorded / recommendationsGenerated — null when zero
   * recommendations exist yet ("not enough evidence", never a fabricated
   * 0%/NaN, matching evaluationReadModel.ts::agreementRate's own
   * discipline). Deliberately named with an explicit denominator in its own
   * name/doc comment rather than "conversion rate" (P1 Sprint 6 directive
   * §12: that word implies a sales-funnel claim this figure does not
   * support). */
  followThroughCoverageRate: number | null;
  malformedFollowThroughCount: number;
  diagnostics: CommercialEvidenceDiagnostic[];
};

function isEstimateClosingDispositionMismatch(disposition: FollowThroughBusinessDisposition, leadStatus: string | null): boolean {
  if (disposition === "won") return leadStatus !== "Won";
  if (disposition === "lost") return leadStatus !== "Lost";
  return false;
}

/** Pure — takes already-fetched, already-validated data. Powers
 * getEstimateClosingCommercialEvidence below and is directly unit-tested
 * without any store. */
export function computeEstimateClosingCommercialEvidence(input: {
  recommendations: EstimateClosingRecommendationView[];
  reviews: EstimateClosingRecommendationReviewView[];
  followThroughEvents: Array<Pick<BusinessEvent, "causationId" | "occurredAt" | "payload">>;
  /** leadId -> current LeadStatus, for disposition corroboration. Only the
   * status field is needed — never the full lead record. */
  leadStatusByLeadId: Map<string, string>;
}): EstimateClosingCommercialEvidence {
  const reviewedIds = new Set(input.reviews.map((r) => r.recommendationEventId));
  const { current: followThroughByRecommendation, skippedMalformed } = resolveCurrentFollowThroughByRecommendation(input.followThroughEvents);

  let actedYes = 0;
  let actedNo = 0;
  let actedLater = 0;
  let customerResponsesObserved = 0;
  let ownerReportedWon = 0;
  let ownerReportedLost = 0;
  let ownerReportedPending = 0;
  const diagnostics: CommercialEvidenceDiagnostic[] = [];

  for (const rec of input.recommendations) {
    const record = followThroughByRecommendation.get(rec.recommendationEventId);
    if (!record) continue;
    const { followThrough, occurredAt } = record;

    if (followThrough.actionTaken === "yes") actedYes += 1;
    else if (followThrough.actionTaken === "no") actedNo += 1;
    else actedLater += 1;

    if (followThrough.customerResponse === "observed") customerResponsesObserved += 1;

    if (followThrough.businessDisposition === "won") ownerReportedWon += 1;
    else if (followThrough.businessDisposition === "lost") ownerReportedLost += 1;
    else if (followThrough.businessDisposition === "pending") ownerReportedPending += 1;

    // Diagnostics — data-quality signals only, never auto-corrected.
    if (occurredAt < rec.occurredAt) {
      diagnostics.push({ code: "followthrough_before_recommendation", recommendationEventId: rec.recommendationEventId });
    }
    if (followThrough.customerResponse === "observed" && followThrough.actionTaken !== "yes") {
      diagnostics.push({ code: "response_observed_without_action", recommendationEventId: rec.recommendationEventId });
    }
    if (followThrough.businessDisposition === "won" || followThrough.businessDisposition === "lost") {
      const leadStatus = rec.leadId ? (input.leadStatusByLeadId.get(rec.leadId) ?? null) : null;
      if (isEstimateClosingDispositionMismatch(followThrough.businessDisposition, leadStatus)) {
        diagnostics.push({ code: "disposition_lead_status_mismatch", recommendationEventId: rec.recommendationEventId });
      }
    }
  }

  const followthroughRecorded = followThroughByRecommendation.size;
  const recommendationsGenerated = input.recommendations.length;

  return {
    recommendationsGenerated,
    recommendationsReviewed: reviewedIds.size,
    recommendationsAwaitingReview: Math.max(0, recommendationsGenerated - reviewedIds.size),
    followthroughRecorded,
    actedYes,
    actedNo,
    actedLater,
    customerResponsesObserved,
    ownerReportedWon,
    ownerReportedLost,
    ownerReportedPending,
    recommendationsWithoutFollowthrough: Math.max(0, recommendationsGenerated - followthroughRecorded),
    followThroughCoverageRate: recommendationsGenerated > 0 ? followthroughRecorded / recommendationsGenerated : null,
    malformedFollowThroughCount: skippedMalformed,
    diagnostics,
  };
}

export type CommercialEvidenceDeps = {
  eventStore?: BusinessEventStore;
  getLeadsForTenant?: typeof getLeads;
};

export async function getEstimateClosingCommercialEvidence(tenantId: string, deps: CommercialEvidenceDeps = {}): Promise<EstimateClosingCommercialEvidence> {
  const eventStore = deps.eventStore ?? new SupabaseBusinessEventStore();
  const getLeadsForTenant = deps.getLeadsForTenant ?? getLeads;

  const recommendationsResult = await listEstimateClosingRecommendations(tenantId, { eventStore });
  const recommendationIds = recommendationsResult.recommendations.map((r) => r.recommendationEventId);

  const [reviewsResult, followThroughEvents, { leads }] = await Promise.all([
    listEstimateClosingRecommendationReviews(tenantId, recommendationIds, { eventStore }),
    recommendationIds.length > 0
      ? eventStore.listByTenant(tenantId, { eventType: FOLLOWTHROUGH_EVENT_TYPE, causationIdIn: recommendationIds })
      : Promise.resolve([]),
    getLeadsForTenant(tenantId),
  ]);

  const leadStatusByLeadId = new Map<string, string>((leads as PlumbingLead[]).map((lead) => [lead.id, lead.status]));

  return computeEstimateClosingCommercialEvidence({
    recommendations: recommendationsResult.recommendations,
    reviews: reviewsResult.reviews,
    followThroughEvents: followThroughEvents.map((e) => ({ causationId: e.causationId, occurredAt: e.occurredAt, payload: e.payload })),
    leadStatusByLeadId,
  });
}
