import { PlumbingLead } from "@/data/leadModel";
import { getLeads, buildLeadMetrics } from "@/lib/leads/repository";
import { getMissedCallAnalytics } from "@/lib/modules/missedCallRecovery/service";
import { getEstimateFollowupAnalytics } from "@/lib/modules/estimateFollowup/service";
import { SupabaseAgentStore } from "@/lib/agents/agentStore";
import { SupabaseAgentRunStore } from "@/lib/agents/runStore";
import { SupabaseApprovalStore } from "@/lib/approvals/store";
import { SupabaseOutcomeStore } from "@/lib/outcomes/store";
import { SupabaseBusinessEventStore } from "@/lib/events/store";
import { EstimateClosingRecommendation } from "@/lib/agents/estimateClosing/types";
import { ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID } from "@/lib/agents/estimateClosing/mode";
import { isEstimateClosingShadowEnabled } from "@/lib/agents/estimateClosing/featureFlag";
import {
  listEstimateClosingRecommendations,
  summarizeEstimateClosingRecommendations,
  selectFeaturedRecommendations,
  EstimateClosingRecommendationSummary,
} from "@/lib/agents/estimateClosing/recommendationReadModel";
import { resolveEstimateClosingAgentStatus, EstimateClosingAgentStatus } from "@/lib/agents/estimateClosing/status";
import { listEstimateClosingRecommendationReviews } from "@/lib/agents/estimateClosing/evaluationReadModel";

/**
 * P1B Revenue Command Center — assembles the dashboard's data in one
 * place, parallelizing every independent read (P1 directive §22:
 * "Parallelize independent reads... Avoid pulling unlimited agent
 * history... Bound recent activity queries"), so app/(app)/dashboard/page.tsx
 * stays a thin rendering layer.
 *
 * Every number here is computed from a real query — nothing is
 * hardcoded/estimated for display (P1 directive §21 "No Fake Data").
 * `directRevenueRecoveredUsd` in particular is 0 whenever no `direct`
 * outcome exists, truthfully — see OUTCOME_ATTRIBUTION.md; it never blends
 * in `assisted`/`inferred`/`unknown` values.
 */

const RECENT_ACTIVITY_LIMIT = 12;
const RECENT_RUNS_LIMIT = 10;
/** Bounded — the P1 Sprint 2 directive requires "a small bounded number of
 * the highest-value/recent actionable recommendations," not the entire
 * (already-bounded-at-the-read-model-level) window. Ranking (actionable
 * before "wait", higher opportunity value first) happens via
 * selectFeaturedRecommendations BEFORE this limit is applied — a plain
 * recency slice could otherwise hide an older high-value recommendation
 * behind several newer, lower-priority ones (Codex review finding on
 * PR #20). */
const DASHBOARD_RECOMMENDATION_CARD_LIMIT = 4;
// Note: "Direct Revenue Recovered by AI" deliberately does NOT use a
// bounded limit like the constants above — it is computed via
// OutcomeStore.sumDirectAttributionValue(), a real database SUM()
// aggregate (db/migrations/021_direct_revenue_aggregate.sql) over the
// tenant's FULL lifetime direct-attribution outcome history, proven
// correct against >5000 rows in
// lib/outcomes/directRevenueAggregate.pg.test.ts. A bounded fetch-and-
// reduce over this figure previously could silently undercount once a
// tenant's direct-outcome row count exceeded the fetch limit (Codex
// review finding on PR #18) — bounding is correct for the activity feeds
// below, which are intentionally windowed views, but was never correct
// for a lifetime headline total.

export type AttentionItemKind = "emergency_lead" | "overdue_follow_up" | "stalled_estimate" | "pending_approval" | "agent_failure";

export type AttentionItem = {
  kind: AttentionItemKind;
  title: string;
  description: string;
  value?: string;
  href: string;
  occurredAt: string;
};

export type ShadowRecommendationView = {
  eventId: string;
  occurredAt: string;
  serviceType: string;
  customerName: string | null;
  leadId: string;
  recommendation: EstimateClosingRecommendation;
};

export type AgentActivityItem = {
  id: string;
  kind: "agent_run" | "business_event";
  title: string;
  description: string;
  occurredAt: string;
  status: string | null;
};

export type RevenueCommandCenterData = {
  tenantName: string;
  leads: PlumbingLead[];
  metrics: ReturnType<typeof buildLeadMetrics>;
  missedCallAnalytics: Awaited<ReturnType<typeof getMissedCallAnalytics>>;
  estimateFollowupAnalytics: Awaited<ReturnType<typeof getEstimateFollowupAnalytics>>;
  directRevenueRecoveredUsd: number;
  pendingApprovalsCount: number;
  attentionItems: AttentionItem[];
  shadowRecommendations: ShadowRecommendationView[];
  recentActivity: AgentActivityItem[];
  /** @deprecated use estimateClosingAgentStatus === "active" — kept only
   * because it is a strict narrowing of the same underlying fact; prefer
   * the tri-state field for anything UI-facing so "never registered" and
   * "registered but off" don't collapse into the same falsy value. */
  estimateClosingAgentActive: boolean;
  estimateClosingAgentStatus: EstimateClosingAgentStatus;
  /** The production kill switch (featureFlag.ts) — independent of the
   * agent row's own status. Both must be true for Shadow Mode to actually
   * run; the UI shows each truthfully rather than collapsing them. */
  estimateClosingShadowEnabled: boolean;
  /** Aggregate observation/recommendation metrics — see
   * recommendationReadModel.ts's doc comment for why these reflect a
   * bounded recent window, not a lifetime total, and why they must never
   * be presented as recovered/won revenue. */
  estimateClosingSummary: EstimateClosingRecommendationSummary;
  /** P1 Sprint 3 — how many of the (bounded) recent recommendations the
   * owner has already reviewed. Powers the "Review Shadow intelligence"
   * link into /agentic/estimate-closing; the dashboard itself stays a
   * thin summary, not an evaluation console (P1 Sprint 3 directive §10). */
  estimateClosingRecommendationsReviewed: number;
};

/** Exported for unit testing (dashboard/attention.test.ts) — the same
 * "overdue" rule app/(app)/follow-ups/page.tsx already applies, so the
 * dashboard's attention section and the Follow-Ups page can never disagree
 * about which leads are overdue. */
export function isOverdueFollowUp(lead: PlumbingLead, today: string): boolean {
  return Boolean(lead.followUpDate) && lead.followUpDate <= today && !["Completed", "Lost"].includes(lead.status);
}

/** Exported for unit testing — an emergency lead stops needing urgent
 * attention once it reaches a terminal status. */
export function isUnresolvedEmergency(lead: PlumbingLead): boolean {
  return lead.emergency === "Yes" && !["Completed", "Lost", "Won"].includes(lead.status);
}

export async function buildRevenueCommandCenterData(tenantId: string, tenantName: string): Promise<RevenueCommandCenterData> {
  const agentStore = new SupabaseAgentStore();
  const runStore = new SupabaseAgentRunStore();
  const approvalStore = new SupabaseApprovalStore();
  const outcomeStore = new SupabaseOutcomeStore();
  const eventStore = new SupabaseBusinessEventStore();

  const [
    { leads },
    missedCallAnalytics,
    estimateFollowupAnalytics,
    agents,
    recentRuns,
    pendingApprovals,
    directRevenueRecoveredUsd,
    stalledEvents,
    recommendationsResult,
    reviewsResult,
  ] = await Promise.all([
    getLeads(tenantId),
    getMissedCallAnalytics(tenantId),
    getEstimateFollowupAnalytics(tenantId),
    agentStore.listByTenant(tenantId),
    runStore.listByTenant(tenantId, { limit: RECENT_RUNS_LIMIT }),
    approvalStore.listByTenant(tenantId, { status: "pending" }),
    outcomeStore.sumDirectAttributionValue(tenantId),
    eventStore.listByTenant(tenantId, { eventType: "estimate.stalled", limit: RECENT_ACTIVITY_LIMIT }),
    // Dedicated, validated read model (P1 Sprint 2) — never parses a raw
    // business_event payload here directly; a malformed historical payload
    // is safely excluded rather than trusted or crashing the page. See
    // recommendationReadModel.ts.
    listEstimateClosingRecommendations(tenantId),
    // P1 Sprint 3 — bounded review-count only; the dashboard links to
    // /agentic/estimate-closing for the full evaluation console rather
    // than duplicating it here (directive §10: "Do not make Dashboard a
    // giant evaluation console").
    listEstimateClosingRecommendationReviews(tenantId),
  ]);

  const metrics = buildLeadMetrics(leads);
  const leadsById = new Map(leads.map((lead) => [lead.id, lead]));
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const estimateClosingAgentStatus = resolveEstimateClosingAgentStatus(agents);
  const estimateClosingAgentActive = estimateClosingAgentStatus === "active";
  const estimateClosingShadowEnabled = isEstimateClosingShadowEnabled();
  const estimateClosingSummary = summarizeEstimateClosingRecommendations(recommendationsResult.recommendations);

  const today = new Date().toISOString().slice(0, 10);

  const attentionItems: AttentionItem[] = [];

  for (const lead of leads) {
    if (isUnresolvedEmergency(lead)) {
      attentionItems.push({
        kind: "emergency_lead",
        title: lead.customerName,
        description: `Emergency ${lead.serviceType} request — status: ${lead.status}`,
        href: `/leads/${lead.id}`,
        occurredAt: lead.date,
      });
    }
    if (isOverdueFollowUp(lead, today)) {
      attentionItems.push({
        kind: "overdue_follow_up",
        title: lead.customerName,
        description: `Follow-up was due ${lead.followUpDate}`,
        href: `/leads/${lead.id}`,
        occurredAt: lead.followUpDate,
      });
    }
  }

  for (const event of stalledEvents) {
    const lead = event.entityId ? leadsById.get(event.entityId) : undefined;
    // A stalled event is a historical fact — "this estimate went stalled at
    // time T" — but the lead may have since moved on (won, lost, completed,
    // or simply deleted) or received a reply the sequence recorded. Re-check
    // CURRENT state before presenting it as still-open work; an event whose
    // estimate has since resolved is correctly excluded here rather than
    // lingering in the attention list (and the executive header's count)
    // until enough newer stalled events push it out of the fetch window.
    if (!lead || lead.status !== "Estimate Sent") continue;
    const amount = typeof event.payload.estimateAmount === "number" ? event.payload.estimateAmount : null;
    attentionItems.push({
      kind: "stalled_estimate",
      title: lead.customerName,
      description: `${lead.serviceType} has had no response since it was sent`,
      value: amount != null ? `$${amount.toLocaleString()}` : undefined,
      href: `/leads/${lead.id}`,
      occurredAt: event.occurredAt,
    });
  }

  for (const approval of pendingApprovals) {
    attentionItems.push({
      kind: "pending_approval",
      title: "Approval needed",
      description: approval.requestedAction,
      href: "/agentic",
      occurredAt: approval.createdAt,
    });
  }

  for (const run of recentRuns) {
    if (run.status === "failed") {
      attentionItems.push({
        kind: "agent_failure",
        title: agentNameById.get(run.agentId) ?? "Agent",
        description: run.failureReason ?? "The agent run failed.",
        href: "/agentic",
        occurredAt: run.completedAt ?? run.createdAt,
      });
    }
  }

  attentionItems.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  // Rank BEFORE bounding — the dashboard card grid must never lose an
  // older high-value follow_up/owner_review behind newer, lower-priority
  // "wait" recommendations (Codex review finding on PR #20).
  const featuredRecommendations = selectFeaturedRecommendations(recommendationsResult.recommendations, DASHBOARD_RECOMMENDATION_CARD_LIMIT);

  const shadowRecommendations: ShadowRecommendationView[] = featuredRecommendations.map((rec) => {
    const lead = rec.leadId ? leadsById.get(rec.leadId) : undefined;
    return {
      eventId: rec.recommendationEventId,
      occurredAt: rec.occurredAt,
      serviceType: lead?.serviceType ?? "Estimate",
      customerName: lead?.customerName ?? null,
      leadId: rec.leadId ?? "",
      recommendation: {
        recommendation: rec.recommendation,
        confidence: rec.confidence,
        reasonCodes: rec.reasonCodes,
        suggestedChannel: rec.suggestedChannel,
        suggestedTiming: rec.suggestedTiming,
        opportunityValue: rec.opportunityValue,
        // rationaleLength is not part of the read model's view (the raw
        // model rationale never crosses this layer at all — see
        // recommendationReadModel.ts) — 0 here is not "empty rationale",
        // it is "this field is intentionally not carried this far."
        rationaleLength: 0,
      } satisfies EstimateClosingRecommendation,
    };
  });

  const recentActivity: AgentActivityItem[] = recentRuns.map((run) => ({
    id: run.id,
    kind: "agent_run",
    title: agentNameById.get(run.agentId) ?? "Agent",
    description:
      run.status === "failed"
        ? run.failureReason ?? "Run failed."
        : run.workflowId === ESTIMATE_CLOSING_SHADOW_WORKFLOW_ID
          ? "Analyzed a stalled estimate — no action taken (Shadow Mode)."
          : `Run ${run.status}.`,
    occurredAt: run.completedAt ?? run.startedAt ?? run.createdAt,
    status: run.status,
  }));

  return {
    tenantName,
    leads,
    metrics,
    missedCallAnalytics,
    estimateFollowupAnalytics,
    directRevenueRecoveredUsd,
    pendingApprovalsCount: pendingApprovals.length,
    attentionItems,
    shadowRecommendations,
    recentActivity,
    estimateClosingAgentActive,
    estimateClosingAgentStatus,
    estimateClosingShadowEnabled,
    estimateClosingSummary,
    estimateClosingRecommendationsReviewed: reviewsResult.reviews.length,
  };
}
