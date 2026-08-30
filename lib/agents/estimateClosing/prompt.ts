/**
 * P1A — builds the reasoning prompt for the Estimate Closing Agent
 * (Shadow Mode). Deliberately excludes any customer-identifying field
 * (name, phone, email, address, free-text notes) — only categorical
 * business signals (service type, lead source, urgency) and timing/dollar
 * facts cross the model boundary. See types.ts's EstimateClosingLeadContext
 * for the exact narrow shape this is built from.
 */

import { EstimateClosingLeadContext, EstimateFollowupSequenceContext, ESTIMATE_CLOSING_REASON_CODES, SUGGESTED_TIMINGS } from "./types";

export const ESTIMATE_CLOSING_SYSTEM_PROMPT = `You are the Estimate Closing Agent for a home-service business, operating in SHADOW MODE.

You are NOT permitted to contact the customer, change any record, or take any action. Your only job is to analyze a stalled estimate and produce a structured, internal recommendation for the business owner to review.

Respond with ONLY a single JSON object (no markdown fences, no commentary before or after) matching exactly this shape:
{
  "recommendation": "follow_up" | "wait" | "owner_review",
  "confidence": <number between 0 and 1>,
  "reasonCodes": [<zero or more of: ${ESTIMATE_CLOSING_REASON_CODES.join(", ")}>],
  "rationale": "<one or two sentences explaining your reasoning, internal use only>",
  "suggestedChannel": "sms" | "email" | "phone" | "none",
  "suggestedTiming": null | "${SUGGESTED_TIMINGS.join('" | "')}"
}

Guidance:
- "follow_up" means the business should reach out again soon.
- "wait" means no action is needed yet.
- "owner_review" means the situation is ambiguous or high-stakes enough that a human should look at it personally rather than a routine follow-up.
- Use "insufficient_information" in reasonCodes and prefer "owner_review" if the context given is too thin to reason about confidently.
- Never invent facts not present in the context below.`;

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)));
}

export function buildEstimateClosingPrompt(
  lead: EstimateClosingLeadContext,
  sequence: EstimateFollowupSequenceContext,
  now: Date = new Date()
): string {
  const sentAt = new Date(sequence.estimateSentAt);
  const daysSinceSent = daysBetween(sentAt, now);

  const context = {
    estimateAmountUsd: lead.estimateAmount,
    serviceType: lead.serviceType,
    leadSource: lead.leadSource,
    urgency: lead.urgency,
    daysSinceEstimateSent: daysSinceSent,
    followupSequenceStatus: sequence.status,
    automatedFollowupSequenceComplete: sequence.status === "completed",
    replyReceived: sequence.lastReplyAt != null,
  };

  return `Stalled estimate context (JSON):\n${JSON.stringify(context, null, 2)}\n\nProduce your recommendation now, following the exact JSON shape described in your instructions.`;
}
