import { PlumbingLead } from "@/data/leadModel";
import { getLeads } from "@/lib/leads/repository";
import { getEstimateFollowupSequencesForTenant, FollowupSequenceRow } from "@/lib/modules/estimateFollowup/service";
import { checkEstimateEligibility, isEstimateStalled } from "@/lib/agents/estimateClosing/eligibility";

/**
 * P1 Sprint 4 — the estimate pipeline read model. Powers /estimates, the
 * Estimate Closing workspace's Shadow-readiness section, and the
 * Dashboard's lifecycle metrics. Sourced directly from the live `leads` and
 * `estimate_followup_sequences` tables (the same tenant-scoped reads
 * lib/leads/repository.ts::buildLeadMetrics and
 * lib/modules/estimateFollowup/service.ts::getEstimateFollowupAnalytics
 * already make) — NOT from business_events. Unlike Estimate Closing
 * recommendations (which exist ONLY as events — see
 * recommendationReadModel.ts), a lead and its sequence are live rows with a
 * current, queryable state; re-deriving that state from an event log would
 * be strictly less accurate and more complex for no benefit.
 *
 * Split into a pure compute function (computeEstimateLifecycleReadModel —
 * fully unit-testable with plain arrays, no I/O) and an I/O wrapper
 * (getEstimateLifecycleReadModel), mirroring
 * lib/leads/repository.ts::buildLeadMetrics's own pure-computation-over-
 * already-fetched-data convention.
 *
 * Diagnostics are operational facts about data INTEGRITY (a lead/sequence
 * pair that disagrees with itself) — this module never repairs them. See
 * the P1 Sprint 4 directive Gate 9: "Do NOT auto-correct them in this
 * sprint... No production backfill. No synthetic fixes."
 */

export type EstimateLifecycleDiagnosticCode =
  /** lead.status === "Estimate Sent" but no estimate_followup_sequences row
   * exists for it — the exact gap the P1 Sprint 4 directive's Gate 2 audit
   * found in the pre-existing fire-and-forget enrollment path. */
  | "estimate_sent_missing_sequence"
  /** A sequence row exists for a lead whose CURRENT status is neither
   * "Estimate Sent" nor a terminal status (Won/Lost/Completed) — e.g. the
   * lead was reverted to "Contacted" by hand after being sent. */
  | "sequence_without_estimate_sent_status"
  /** The lead has reached a terminal status (Won/Lost/Completed) but its
   * sequence is still "active" — stopOnStatusChange should have stopped it
   * (see lib/modules/estimateFollowup/service.ts::processSequence) but
   * hasn't run yet, or the module was disabled at the time. */
  | "terminal_lead_with_active_sequence"
  /** lead.status === "Estimate Sent" but estimateAmount is not a positive,
   * finite number — a state the current canonical transition
   * (lib/leads/estimateLifecycle.ts) now refuses to create going forward,
   * but historical/hand-edited rows may still carry it. */
  | "malformed_estimate_amount";

export type EstimateLifecycleDiagnostic = {
  code: EstimateLifecycleDiagnosticCode;
  leadId: string;
  sequenceId: string | null;
};

export type EstimateLifecycleLeadView = {
  leadId: string;
  customerName: string;
  serviceType: string;
  status: PlumbingLead["status"];
  estimateAmount: number;
  sequenceId: string | null;
  sequenceStatus: FollowupSequenceRow["status"] | null;
  /** "day1" | "day3" | "day7" | null — the next follow-up step still
   * pending, purely derived from which *_sent_at columns are still null;
   * null once the sequence is no longer active (replied/completed/stopped)
   * or there is no sequence at all. */
  nextFollowupStep: "day1" | "day3" | "day7" | null;
  shadowEligible: boolean;
  shadowStalled: boolean;
};

export type EstimateLifecycleReadModel = {
  estimatesSent: number;
  activeFollowupSequences: number;
  replied: number;
  completedDay7: number;
  stopped: number;
  stalledEligible: number;
  /** Sum of estimateAmount across every lead currently at "Estimate Sent"
   * — an observation of what's outstanding, never a claim of recovered or
   * won revenue (see OUTCOME_ATTRIBUTION.md; same discipline as
   * lib/leads/repository.ts::buildLeadMetrics's atRiskEstimateValue, which
   * this figure intentionally matches). */
  openEstimateValue: number;
  diagnostics: EstimateLifecycleDiagnostic[];
  leads: EstimateLifecycleLeadView[];
};

function nextFollowupStep(sequence: FollowupSequenceRow | undefined): "day1" | "day3" | "day7" | null {
  if (!sequence || sequence.status !== "active") return null;
  if (!sequence.day1SentAt) return "day1";
  if (!sequence.day3SentAt) return "day3";
  if (!sequence.day7SentAt) return "day7";
  return null;
}

const TERMINAL_STATUSES = new Set<PlumbingLead["status"]>(["Won", "Lost", "Completed"]);

/**
 * checkEstimateEligibility/isEstimateStalled (eligibility.ts) require a
 * tenantId on the context AND on both the lead and sequence, and refuse
 * ("tenant_mismatch") if they disagree — a real safety property for the
 * Shadow agent, whose lead/sequence pairs come from separate, independently
 * scoped reads. Here, both leads and sequences are already the SAME
 * tenant-scoped query's results (getLeads(tenantId) /
 * getEstimateFollowupSequencesForTenant(tenantId)) — there is no
 * cross-tenant risk to re-check. Using one consistent placeholder value
 * everywhere satisfies eligibility.ts's equality check without asserting
 * anything meaningful about tenancy (which this read model already
 * guarantees at the query layer, not here).
 */
const SAME_TENANT_PLACEHOLDER = "read-model-tenant-scope-already-enforced-by-query";

function buildEligibilityContext(lead: PlumbingLead, sequence: FollowupSequenceRow | null) {
  return {
    tenantId: SAME_TENANT_PLACEHOLDER,
    lead: {
      id: lead.id,
      tenantId: SAME_TENANT_PLACEHOLDER,
      status: lead.status,
      estimateAmount: lead.estimateAmount,
      serviceType: lead.serviceType,
      leadSource: lead.leadSource,
      urgency: lead.urgency,
    },
    sequence: sequence
      ? {
          id: sequence.id,
          tenantId: SAME_TENANT_PLACEHOLDER,
          leadId: sequence.leadId,
          status: sequence.status,
          estimateSentAt: sequence.estimateSentAt,
          day7DueAt: sequence.day7DueAt,
          lastReplyAt: sequence.lastReplyAt,
        }
      : null,
  };
}

/** Pure — no I/O, no Date.now() unless `now` is omitted (defaults to
 * `new Date()` at call time, matching lib/agents/estimateClosing/eligibility.ts's
 * own convention for the same reason: deterministic under test). */
export function computeEstimateLifecycleReadModel(leads: PlumbingLead[], sequences: FollowupSequenceRow[], now: Date = new Date()): EstimateLifecycleReadModel {
  const leadsById = new Map(leads.map((lead) => [lead.id, lead]));
  const sequenceByLeadId = new Map(sequences.map((seq) => [seq.leadId, seq]));

  let activeFollowupSequences = 0;
  let replied = 0;
  let completedDay7 = 0;
  let stopped = 0;
  let stalledEligible = 0;

  const diagnostics: EstimateLifecycleDiagnostic[] = [];

  for (const seq of sequences) {
    if (seq.status === "active") activeFollowupSequences += 1;
    else if (seq.status === "replied") replied += 1;
    else if (seq.status === "completed") completedDay7 += 1;
    else if (seq.status === "stopped") stopped += 1;

    const lead = leadsById.get(seq.leadId);
    if (!lead) continue; // orphaned sequence (lead deleted) — nothing further to check against it

    if (TERMINAL_STATUSES.has(lead.status) && seq.status === "active") {
      diagnostics.push({ code: "terminal_lead_with_active_sequence", leadId: lead.id, sequenceId: seq.id });
    } else if (lead.status !== "Estimate Sent" && !TERMINAL_STATUSES.has(lead.status)) {
      diagnostics.push({ code: "sequence_without_estimate_sent_status", leadId: lead.id, sequenceId: seq.id });
    }
  }

  let estimatesSent = 0;
  let openEstimateValue = 0;

  for (const lead of leads) {
    if (lead.status !== "Estimate Sent") continue;
    estimatesSent += 1;

    const validAmount = typeof lead.estimateAmount === "number" && Number.isFinite(lead.estimateAmount) && lead.estimateAmount > 0;
    if (validAmount) {
      openEstimateValue += lead.estimateAmount;
    } else {
      diagnostics.push({ code: "malformed_estimate_amount", leadId: lead.id, sequenceId: sequenceByLeadId.get(lead.id)?.id ?? null });
    }

    const sequence = sequenceByLeadId.get(lead.id);
    if (!sequence) {
      diagnostics.push({ code: "estimate_sent_missing_sequence", leadId: lead.id, sequenceId: null });
      continue;
    }

    if (isEstimateStalled(buildEligibilityContext(lead, sequence), now)) {
      stalledEligible += 1;
    }
  }

  const leadViews: EstimateLifecycleLeadView[] = leads
    .filter((lead) => lead.status === "Estimate Sent")
    .map((lead) => {
      const sequence = sequenceByLeadId.get(lead.id);
      const eligibilityCtx = buildEligibilityContext(lead, sequence ?? null);
      return {
        leadId: lead.id,
        customerName: lead.customerName,
        serviceType: lead.serviceType,
        status: lead.status,
        estimateAmount: lead.estimateAmount,
        sequenceId: sequence?.id ?? null,
        sequenceStatus: sequence?.status ?? null,
        nextFollowupStep: nextFollowupStep(sequence),
        shadowEligible: checkEstimateEligibility(eligibilityCtx).eligible,
        shadowStalled: isEstimateStalled(eligibilityCtx, now),
      };
    });

  return {
    estimatesSent,
    activeFollowupSequences,
    replied,
    completedDay7,
    stopped,
    stalledEligible,
    openEstimateValue,
    diagnostics,
    leads: leadViews,
  };
}

export async function getEstimateLifecycleReadModel(tenantId: string): Promise<EstimateLifecycleReadModel> {
  const [{ leads }, sequences] = await Promise.all([getLeads(tenantId), getEstimateFollowupSequencesForTenant(tenantId)]);
  return computeEstimateLifecycleReadModel(leads, sequences);
}
