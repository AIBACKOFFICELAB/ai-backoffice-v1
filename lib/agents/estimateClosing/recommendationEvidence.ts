import { BusinessEventStore, SupabaseBusinessEventStore } from "@/lib/events/store";
import { AgentRunStore, SupabaseAgentRunStore, AgentRunStatus } from "../runStore";
import { ModelInvocationStore, SupabaseModelInvocationStore } from "@/lib/ai/store";
import { getEstimateFollowupSequencesForTenant, FollowupSequenceRow } from "@/lib/modules/estimateFollowup/service";
import { getLeadById } from "@/lib/leads/repository";
import { LeadStatus } from "@/data/leadModel";
import { parsePersistedRecommendationPayload, EstimateClosingRecommendationView } from "./recommendationReadModel";
import { listEstimateClosingRecommendationReviews, EstimateClosingRecommendationReviewView } from "./evaluationReadModel";
import { EstimateClosingRecommendationFollowThrough } from "./followThroughTypes";
import {
  resolveCurrentFollowThroughByRecommendation,
  resolveEstimateClosingAttributionState,
  EstimateClosingAttributionState,
} from "./commercialEvidence";

const FOLLOWTHROUGH_EVENT_TYPE = "estimate.closing_recommendation_followthrough_recorded";

/**
 * P1 Sprint 5 §12 — the FIRST RECOMMENDATION EVIDENCE PACKET. Resolves only
 * tenant-owned data and safely connects what current schema/events already
 * support: the triggering estimate.stalled event, the recommendation
 * itself, the related agent_run, its model_invocation metadata, current
 * lifecycle/sequence state, current lead status, and the owner's review (if
 * one exists). Every relation that CANNOT be reliably resolved is labeled
 * unavailable/null — never fabricated. Displays only persisted SAFE fields;
 * see modelInvocation below for exactly what "safe" means here.
 */

export type RecommendationEvidenceModelInvocation = {
  provider: string;
  model: string;
  status: "succeeded" | "failed";
  /** Fixed, sanitized taxonomy string — see lib/ai/types.ts's
   * AiGatewayErrorCategory. Null on success. */
  errorCategory: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type RecommendationEvidenceAgentRun = {
  id: string;
  status: AgentRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  /** The SAME privacy-safe fingerprint (sha256 digest + char count, never
   * raw text) shadowRunner.ts already persists — see AGENT_SECURITY.md's
   * "Privacy-minimized tool audit summaries" for the identical discipline
   * applied here to model output. */
  outputFingerprint: string | null;
};

export type RecommendationEvidenceSequence = Pick<FollowupSequenceRow, "status" | "estimateSentAt" | "day7DueAt" | "lastReplyAt">;

export type EstimateClosingRecommendationEvidence =
  | {
      found: true;
      recommendation: EstimateClosingRecommendationView;
      stalledEventFound: boolean;
      stalledEventOccurredAt: string | null;
      agentRun: RecommendationEvidenceAgentRun | null;
      modelInvocation: RecommendationEvidenceModelInvocation | null;
      sequence: RecommendationEvidenceSequence | null;
      leadStatus: LeadStatus | null;
      review: EstimateClosingRecommendationReviewView | null;
      /** P1 Sprint 6 — the CURRENT (most recent, see followThrough.ts's
       * append-only/correction discipline) owner-recorded follow-through
       * for this recommendation, or null if none has ever been recorded.
       * An OBSERVATION, never an outcome — see followThroughTypes.ts. */
      followThrough: EstimateClosingRecommendationFollowThrough | null;
      followThroughOccurredAt: string | null;
      /** P1 Sprint 6 §13 — the pure evidence-ladder state for this
       * recommendation. attributionStage is always
       * "ATTRIBUTION_NOT_ESTABLISHED" this sprint — see
       * commercialEvidence.ts's own doc comment. */
      attributionState: EstimateClosingAttributionState;
      /** Always false — structural facts, not live query results. Shadow
       * Mode has no toolPlan anywhere in its signature and never calls
       * requestApproval() or any SEND-permission tool — see
       * shadowRunner.ts's own doc comment. */
      toolCallExists: false;
      approvalExists: false;
      customerActionExists: false;
    }
  | { found: false };

export type RecommendationEvidenceDeps = {
  eventStore?: BusinessEventStore;
  runStore?: AgentRunStore;
  modelInvocationStore?: ModelInvocationStore;
  /** Injectable so this module can be unit-tested in plain Vitest — the
   * real defaults transitively call createServerSupabaseClient()
   * (next/headers), which requires an actual Next.js request context and
   * cannot run outside one (the same established limitation documented on
   * every other function in this codebase that touches Supabase directly).
   * Production callers never pass these; only tests do. */
  getSequencesForTenant?: typeof getEstimateFollowupSequencesForTenant;
  getLead?: typeof getLeadById;
};

export async function getEstimateClosingRecommendationEvidence(
  params: { tenantId: string; recommendationEventId: string },
  deps: RecommendationEvidenceDeps = {}
): Promise<EstimateClosingRecommendationEvidence> {
  const eventStore = deps.eventStore ?? new SupabaseBusinessEventStore();
  const runStore = deps.runStore ?? new SupabaseAgentRunStore();
  const modelInvocationStore = deps.modelInvocationStore ?? new SupabaseModelInvocationStore();
  const getSequencesForTenant = deps.getSequencesForTenant ?? getEstimateFollowupSequencesForTenant;
  const getLead = deps.getLead ?? getLeadById;

  // Tenant-scoped by construction (BusinessEventStore.getById filters by
  // tenant_id) — a recommendationEventId belonging to another tenant, or
  // that doesn't exist at all, returns the identical `{ found: false }`
  // either way. Mirrors review.ts::recordEstimateClosingRecommendationReview's
  // established non-enumerating posture — never lets a caller distinguish
  // "wrong tenant" from "doesn't exist."
  const recommendationEvent = await eventStore.getById(params.tenantId, params.recommendationEventId);
  if (!recommendationEvent || recommendationEvent.eventType !== "estimate.closing_recommendation_generated") {
    return { found: false };
  }

  const parsed = parsePersistedRecommendationPayload(recommendationEvent.payload);
  if (!parsed.ok) return { found: false }; // malformed persisted data — never build evidence from it

  const recommendation: EstimateClosingRecommendationView = {
    recommendationEventId: recommendationEvent.id,
    agentRunId: parsed.value.agentRunId,
    leadId: recommendationEvent.entityId,
    sequenceId: parsed.value.sequenceId,
    occurredAt: recommendationEvent.occurredAt,
    recommendation: parsed.value.recommendation,
    confidence: parsed.value.confidence,
    reasonCodes: parsed.value.reasonCodes,
    suggestedChannel: parsed.value.suggestedChannel,
    suggestedTiming: parsed.value.suggestedTiming,
    opportunityValue: parsed.value.opportunityValue,
    mode: "shadow",
  };

  const [stalledEvent, agentRun, sequences, leadResult, reviewsResult, followThroughEvents] = await Promise.all([
    recommendationEvent.causationId ? eventStore.getById(params.tenantId, recommendationEvent.causationId) : Promise.resolve(null),
    parsed.value.agentRunId ? runStore.getById(params.tenantId, parsed.value.agentRunId) : Promise.resolve(null),
    getSequencesForTenant(params.tenantId),
    recommendationEvent.entityId ? getLead(recommendationEvent.entityId, params.tenantId) : Promise.resolve({ lead: undefined, source: "mock-fallback" as const }),
    listEstimateClosingRecommendationReviews(params.tenantId, [recommendationEvent.id], { eventStore }),
    eventStore.listByTenant(params.tenantId, { eventType: FOLLOWTHROUGH_EVENT_TYPE, causationIdIn: [recommendationEvent.id] }),
  ]);

  const { current: followThroughByRecommendation } = resolveCurrentFollowThroughByRecommendation(
    followThroughEvents.map((e) => ({ causationId: e.causationId, occurredAt: e.occurredAt, payload: e.payload }))
  );
  const currentFollowThrough = followThroughByRecommendation.get(recommendationEvent.id) ?? null;
  const review = reviewsResult.reviews[0] ?? null;

  const sequence = parsed.value.sequenceId ? (sequences.find((s) => s.id === parsed.value.sequenceId) ?? null) : null;

  let modelInvocation: RecommendationEvidenceModelInvocation | null = null;
  if (agentRun) {
    const invocations = await modelInvocationStore.listByAgentRun(params.tenantId, agentRun.id);
    // The Shadow reasoning call itself (this run has no other model call —
    // see shadowRunner.ts, which invokes the gateway exactly once per run).
    // Most recent by insertion order.
    const invocation = invocations[invocations.length - 1] ?? null;
    if (invocation) {
      modelInvocation = {
        provider: invocation.provider,
        model: invocation.model,
        status: invocation.status,
        errorCategory: invocation.errorCategory,
        latencyMs: invocation.latencyMs,
        inputTokens: invocation.inputTokens,
        outputTokens: invocation.outputTokens,
      };
    }
  }

  return {
    found: true,
    recommendation,
    stalledEventFound: stalledEvent !== null && stalledEvent.eventType === "estimate.stalled",
    stalledEventOccurredAt: stalledEvent && stalledEvent.eventType === "estimate.stalled" ? stalledEvent.occurredAt : null,
    agentRun: agentRun
      ? {
          id: agentRun.id,
          status: agentRun.status,
          startedAt: agentRun.startedAt,
          completedAt: agentRun.completedAt,
          failureReason: agentRun.failureReason,
          outputFingerprint: agentRun.outputSummary,
        }
      : null,
    modelInvocation,
    sequence: sequence ? { status: sequence.status, estimateSentAt: sequence.estimateSentAt, day7DueAt: sequence.day7DueAt, lastReplyAt: sequence.lastReplyAt } : null,
    leadStatus: leadResult.lead?.status ?? null,
    review,
    followThrough: currentFollowThrough?.followThrough ?? null,
    followThroughOccurredAt: currentFollowThrough?.occurredAt ?? null,
    attributionState: resolveEstimateClosingAttributionState({
      hasReview: review !== null,
      actionTaken: currentFollowThrough?.followThrough.actionTaken ?? null,
      customerResponse: currentFollowThrough?.followThrough.customerResponse ?? null,
      businessDisposition: currentFollowThrough?.followThrough.businessDisposition ?? null,
    }),
    toolCallExists: false,
    approvalExists: false,
    customerActionExists: false,
  };
}
