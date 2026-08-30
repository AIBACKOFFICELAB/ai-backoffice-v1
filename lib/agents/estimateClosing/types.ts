/**
 * P1A — Estimate Closing Agent (Shadow Mode). See AGENTIC_ROADMAP.md ("2.
 * Intelligent Estimate Closing Agent") and ARCHITECTURE.md.
 *
 * SHADOW MODE INVARIANT: this agent never contacts a customer, never
 * changes lead/estimate state, and never executes a tool. That is not a
 * runtime check alone — shadowRunner.ts's entry point has no `toolPlan`
 * parameter anywhere in its signature, so there is structurally nothing to
 * set to make it otherwise in this slice. See shadowRunner.ts's own doc
 * comment.
 */

import { LeadStatus } from "@/data/leadModel";

export type EstimateClosingRecommendationType = "follow_up" | "wait" | "owner_review";

export type SuggestedChannel = "sms" | "email" | "phone" | "none";

/**
 * Enum, not free text — the model's own sense of "when" is normalized into
 * one of these buckets rather than trusted as an arbitrary string, so it is
 * safe to persist without risking model-generated prose leaking into a
 * durable record. See EstimateClosingRecommendation below.
 */
export const SUGGESTED_TIMINGS = [
  "immediately",
  "within_24_hours",
  "within_3_days",
  "within_7_days",
  "next_scheduled_contact",
] as const;
export type SuggestedTiming = (typeof SUGGESTED_TIMINGS)[number] | null;

/**
 * Fixed, enum-like reason codes — never free text — so the persisted
 * business-event payload never carries model-generated prose. The model
 * selects zero or more of these; validateEstimateClosingModelOutput (see
 * modelContract.ts) rejects any code outside this set rather than passing
 * it through.
 */
export const ESTIMATE_CLOSING_REASON_CODES = [
  "no_response_since_sent",
  "high_value_estimate",
  "low_value_estimate",
  "long_elapsed_time",
  "recent_customer_engagement",
  "repeat_customer",
  "seasonal_urgency",
  "insufficient_information",
  "recently_contacted",
  "automated_sequence_exhausted",
] as const;
export type EstimateClosingReasonCode = (typeof ESTIMATE_CLOSING_REASON_CODES)[number];

/**
 * What the model is asked to produce, validated by
 * modelContract.ts::validateEstimateClosingModelOutput via
 * ai.generateStructured. Deliberately excludes opportunityValue — that
 * dollar figure is computed deterministically from the estimate's own
 * stored amount in application code (buildEstimateClosingRecommendation in
 * shadowRunner.ts), never trusted from model output. The P1 directive's
 * "never fabricate ROI" principle applies to any dollar figure a model
 * could otherwise invent, same as P0.8's outcome-attribution honesty rule.
 *
 * `rationale` is required from the model (it has to show its work, and a
 * malformed/empty rationale is a signal the response itself is
 * low-quality) but is NEVER persisted verbatim anywhere — see
 * EstimateClosingRecommendation below, which carries only its length.
 */
export type EstimateClosingModelOutput = {
  recommendation: EstimateClosingRecommendationType;
  confidence: number; // 0..1
  reasonCodes: EstimateClosingReasonCode[];
  rationale: string;
  suggestedChannel: SuggestedChannel;
  suggestedTiming: SuggestedTiming;
};

/**
 * The privacy-safe, persisted form of a shadow recommendation — what
 * actually lands in the estimate.closing_recommendation_generated business
 * event's payload (see stalledScan.ts / shadowRunner.ts) and what the UI
 * renders. No raw rationale text, no customer PII — only structured,
 * bounded fields, mirroring the same discipline
 * ToolDefinition.summarizeInputForAudit already applies elsewhere in this
 * codebase (lib/agents/toolRegistry.ts).
 */
export type EstimateClosingRecommendation = {
  recommendation: EstimateClosingRecommendationType;
  confidence: number;
  reasonCodes: EstimateClosingReasonCode[];
  suggestedChannel: SuggestedChannel;
  suggestedTiming: SuggestedTiming;
  /** Deterministic — the estimate's own stored dollar amount, carried
   * through only when the recommendation implies the opportunity still
   * matters (not "wait" on a $0 estimate, which can't happen per
   * eligibility, but kept explicit/nullable for honesty). Never invented by
   * the model. */
  opportunityValue: number | null;
  /** Shape-only signal (mirrors ToolDefinition audit-summary fields) —
   * never the actual rationale text. */
  rationaleLength: number;
};

/** Narrow, repository-truth lead shape eligibility/reasoning need — never
 * the full PlumbingLead record (which carries name/phone/email/address).
 * serviceType/leadSource/urgency are categorical labels (data/leadModel.ts),
 * not PII — they're what let the model legitimately select reason codes
 * like "repeat_customer" or "seasonal_urgency" without ever seeing a name,
 * phone number, or address. */
export type EstimateClosingLeadContext = {
  id: string;
  tenantId: string;
  status: LeadStatus;
  estimateAmount: number;
  serviceType: string;
  leadSource: string;
  urgency: string;
};

/** Narrow view of an estimate_followup_sequences row — the canonical
 * "was this estimate sent, and what's happened since" record (see
 * lib/modules/estimateFollowup/service.ts). */
export type EstimateFollowupSequenceContext = {
  id: string;
  tenantId: string;
  leadId: string;
  status: "active" | "replied" | "completed" | "stopped";
  estimateSentAt: string;
  day7DueAt: string;
  lastReplyAt: string | null;
};
