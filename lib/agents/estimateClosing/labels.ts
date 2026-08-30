/**
 * P1B — human-readable labels for the Estimate Closing Agent's structured
 * output. Pure, no I/O, kept separate from the component that renders them
 * so the mapping itself is unit-testable and so a missing/unknown value
 * (a future reason code the UI hasn't been updated for) degrades safely
 * instead of rendering "undefined".
 */

import { EstimateClosingReasonCode, EstimateClosingRecommendationType, SuggestedChannel, SuggestedTiming } from "./types";

export const RECOMMENDATION_LABELS: Record<EstimateClosingRecommendationType, string> = {
  follow_up: "Follow up",
  wait: "Wait",
  owner_review: "Needs your review",
};

export const REASON_CODE_LABELS: Record<EstimateClosingReasonCode, string> = {
  no_response_since_sent: "No response since the estimate was sent",
  high_value_estimate: "High-value estimate",
  low_value_estimate: "Lower-value estimate",
  long_elapsed_time: "A long time has passed",
  recent_customer_engagement: "Customer engaged recently",
  repeat_customer: "Repeat customer",
  seasonal_urgency: "Time-sensitive job",
  insufficient_information: "Limited information available",
  recently_contacted: "Recently contacted",
  automated_sequence_exhausted: "Automated follow-ups are complete",
};

export const CHANNEL_LABELS: Record<SuggestedChannel, string> = {
  sms: "Text message",
  email: "Email",
  phone: "Phone call",
  none: "No contact suggested",
};

export const TIMING_LABELS: Record<NonNullable<SuggestedTiming>, string> = {
  immediately: "Right away",
  within_24_hours: "Within 24 hours",
  within_3_days: "Within 3 days",
  within_7_days: "Within 7 days",
  next_scheduled_contact: "At your next scheduled contact",
};

export function labelReasonCode(code: string): string {
  return (REASON_CODE_LABELS as Record<string, string>)[code] ?? code;
}

export function labelRecommendation(value: string): string {
  return (RECOMMENDATION_LABELS as Record<string, string>)[value] ?? value;
}

export function labelChannel(value: string): string {
  return (CHANNEL_LABELS as Record<string, string>)[value] ?? value;
}

export function labelTiming(value: string | null): string | null {
  if (value == null) return null;
  return (TIMING_LABELS as Record<string, string>)[value] ?? value;
}
