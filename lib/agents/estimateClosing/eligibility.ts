/**
 * P1A — canonical eligibility rule for the Estimate Closing Agent (Shadow
 * Mode). Pure, deterministic, no I/O — every decision here is
 * reconstructable from a lead + its estimate_followup_sequences row alone,
 * mirroring lib/agents/permissions.ts's "pure functions, no I/O" pattern
 * for the same testability/auditability reasons.
 *
 * Repository truth this is built on (see DOMAIN_MODEL.md,
 * lib/modules/estimateFollowup/service.ts, data/leadModel.ts — NOT a new
 * data model):
 *   - "estimate exists" / "estimate amount"  -> leads.estimate_amount
 *   - "estimate sent"                        -> leads.status === "Estimate Sent"
 *     (the exact string lib/modules/estimateFollowup/service.ts::processSequence
 *     already checks) AND a corresponding estimate_followup_sequences row
 *     exists (estimateSentAt is only ever set by enrollLeadInFollowup, at
 *     the moment a lead's status becomes "Estimate Sent" — see that file).
 *   - "estimate follow-up state" / "customer response" -> the sequence's
 *     own status ("active" | "replied" | "completed" | "stopped") and
 *     lastReplyAt.
 *   - "won/lost state"                       -> leads.status === "Won" | "Lost" | "Completed"
 *     (data/leadModel.ts::LeadStatus — "Completed" is treated as closed
 *     alongside "Lost": a job that's done needs no more closing attention).
 */

import {
  EstimateClosingLeadContext,
  EstimateFollowupSequenceContext,
} from "./types";

export type EligibilityDenialReason =
  | "malformed_context"
  | "tenant_mismatch"
  | "no_estimate_value"
  | "estimate_not_sent"
  | "already_won"
  | "already_closed"
  | "reply_already_received"
  | "sequence_stopped";

export type EligibilityResult = { eligible: true } | { eligible: false; reason: EligibilityDenialReason };

export type EligibilityContext = {
  tenantId: string;
  lead: EstimateClosingLeadContext | null | undefined;
  /** The lead's estimate_followup_sequences row, if one exists — null means
   * "never enrolled," which is itself a form of "not actually sent" (a lead
   * whose status happens to read "Estimate Sent" but was never enrolled,
   * e.g. a manually-edited status, is not evaluable — there is no sequence
   * to determine stalled-ness from). */
  sequence: EstimateFollowupSequenceContext | null;
};

/**
 * Is this estimate currently eligible for shadow evaluation at all?
 * Deliberately does NOT decide "is it stalled right now" — see
 * isEstimateStalled below, which layers the timing condition on top of
 * this broader "is this even a legitimate candidate" gate. Fails
 * conservatively (never "eligible") on anything malformed or ambiguous —
 * per the P1 directive's "Failure Behavior" section, a shadow evaluation
 * that shouldn't run must never run merely because a check couldn't
 * confirm otherwise.
 */
export function checkEstimateEligibility(ctx: EligibilityContext): EligibilityResult {
  const { tenantId, lead, sequence } = ctx;

  if (!tenantId || !lead || typeof lead.estimateAmount !== "number" || !Number.isFinite(lead.estimateAmount)) {
    return { eligible: false, reason: "malformed_context" };
  }

  if (lead.tenantId !== tenantId) {
    return { eligible: false, reason: "tenant_mismatch" };
  }

  if (lead.estimateAmount <= 0) {
    return { eligible: false, reason: "no_estimate_value" };
  }

  if (lead.status === "Won") {
    return { eligible: false, reason: "already_won" };
  }

  if (lead.status === "Lost" || lead.status === "Completed") {
    return { eligible: false, reason: "already_closed" };
  }

  if (lead.status !== "Estimate Sent") {
    return { eligible: false, reason: "estimate_not_sent" };
  }

  if (!sequence || sequence.tenantId !== tenantId || sequence.leadId !== lead.id) {
    return { eligible: false, reason: "estimate_not_sent" };
  }

  if (sequence.status === "replied" || sequence.lastReplyAt != null) {
    return { eligible: false, reason: "reply_already_received" };
  }

  if (sequence.status === "stopped") {
    return { eligible: false, reason: "sequence_stopped" };
  }

  return { eligible: true };
}

/**
 * "Stalled" (the estimate.stalled trigger — see stalledScan.ts) means: this
 * estimate is eligible AND the automated Day 1 / Day 3 / Day 7 follow-up
 * sequence (lib/modules/estimateFollowup/service.ts) has run its full
 * course — `now >= sequence.day7DueAt` — without a reply or a status
 * change. This is the exact moment the existing business workflow has
 * nothing further automated to do; it deliberately reuses the Day 7
 * threshold the Estimate Follow-up module already computes
 * (computeFollowupDueDates) rather than inventing a new time constant.
 */
export function isEstimateStalled(ctx: EligibilityContext, now: Date = new Date()): boolean {
  const eligibility = checkEstimateEligibility(ctx);
  if (!eligibility.eligible) return false;
  // checkEstimateEligibility already guarantees ctx.sequence is non-null
  // whenever it returns eligible: true (see the estimate_not_sent branch
  // above) — the redundant null check here is defense in depth, not dead
  // code reachable in practice.
  if (!ctx.sequence) return false;
  return now.getTime() >= new Date(ctx.sequence.day7DueAt).getTime();
}
