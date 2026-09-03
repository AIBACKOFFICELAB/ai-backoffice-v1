/**
 * P1 Sprint 6 — pure, dependency-free follow-through enums/types shared by
 * both the server-side follow-through service (followThrough.ts,
 * commercialEvidence.ts) AND the client-side follow-through controls
 * component (components/ai/FollowThroughControls.tsx).
 *
 * Deliberately has ZERO imports of its own, mirroring reviewTypes.ts's own
 * doc comment exactly and for the identical reason: a module that pulls in
 * next/headers (transitively, via SupabaseBusinessEventStore in
 * followThrough.ts/commercialEvidence.ts) can never be imported into
 * client-bundled code without breaking the build.
 *
 * FOLLOW-THROUGH IS NOT REVIEW. Review (reviewTypes.ts) asks "was the AI
 * recommendation good?" — evaluation of the recommendation itself.
 * Follow-through asks "what actually happened after it?" — an
 * OWNER-RECORDED OBSERVATION of real-world events. It is not an approval,
 * not an agent action, not an outcome, and not recovered revenue. See
 * OUTCOME_ATTRIBUTION.md's "Follow-through is not an outcome" section.
 *
 * Enumerated feedback only — no free-text field exists anywhere in this
 * file, by construction, for the same privacy/PII/prompt-injection-surface
 * reasons reviewTypes.ts documents.
 */

export const FOLLOWTHROUGH_ACTION_TAKEN = ["yes", "no", "later"] as const;
export type FollowThroughActionTaken = (typeof FOLLOWTHROUGH_ACTION_TAKEN)[number];

export const FOLLOWTHROUGH_ACTION_CHANNEL = ["phone", "sms", "email", "in_person", "other"] as const;
export type FollowThroughActionChannel = (typeof FOLLOWTHROUGH_ACTION_CHANNEL)[number];

export const FOLLOWTHROUGH_CUSTOMER_RESPONSE = ["observed", "not_observed", "unknown"] as const;
export type FollowThroughCustomerResponse = (typeof FOLLOWTHROUGH_CUSTOMER_RESPONSE)[number];

export const FOLLOWTHROUGH_BUSINESS_DISPOSITION = ["won", "lost", "pending", "unknown"] as const;
export type FollowThroughBusinessDisposition = (typeof FOLLOWTHROUGH_BUSINESS_DISPOSITION)[number];

/** The privacy-safe, persisted form of a follow-through record — what lands
 * in the estimate.closing_recommendation_followthrough_recorded event's
 * payload. Structurally has no field for free text, a customer identifier,
 * a raw message, or a call transcript — there is nowhere to put one even by
 * mistake. `actionChannel` is the only nullable field: null exactly when
 * `actionTaken !== "yes"` (see validateFollowThroughInput's coupling rule)
 * — "no"/"later" never silently implies a channel. */
export type EstimateClosingRecommendationFollowThrough = {
  recommendationEventId: string;
  actionTaken: FollowThroughActionTaken;
  actionChannel: FollowThroughActionChannel | null;
  customerResponse: FollowThroughCustomerResponse;
  businessDisposition: FollowThroughBusinessDisposition;
};

export const ACTION_TAKEN_LABELS: Record<FollowThroughActionTaken, string> = {
  yes: "Yes",
  no: "No",
  later: "Later",
};

export const ACTION_CHANNEL_LABELS: Record<FollowThroughActionChannel, string> = {
  phone: "Phone",
  sms: "SMS",
  email: "Email",
  in_person: "In person",
  other: "Other",
};

export const CUSTOMER_RESPONSE_LABELS: Record<FollowThroughCustomerResponse, string> = {
  observed: "Yes",
  not_observed: "No",
  unknown: "Unknown",
};

export const BUSINESS_DISPOSITION_LABELS: Record<FollowThroughBusinessDisposition, string> = {
  won: "Won",
  lost: "Lost",
  pending: "Still pending",
  unknown: "Unknown",
};

const ACTION_TAKEN_VALUES = new Set<string>(FOLLOWTHROUGH_ACTION_TAKEN);
const ACTION_CHANNEL_VALUES = new Set<string>(FOLLOWTHROUGH_ACTION_CHANNEL);
const CUSTOMER_RESPONSE_VALUES = new Set<string>(FOLLOWTHROUGH_CUSTOMER_RESPONSE);
const BUSINESS_DISPOSITION_VALUES = new Set<string>(FOLLOWTHROUGH_BUSINESS_DISPOSITION);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict shape check against the PERSISTED follow-through payload contract
 * (see followThrough.ts::recordEstimateClosingRecommendationFollowThrough,
 * the only writer). Lives here — not in followThrough.ts or
 * commercialEvidence.ts — so both can share exactly one implementation,
 * mirroring reviewTypes.ts::parsePersistedReviewPayload's own doc comment
 * for the identical reason. A malformed payload is reported as
 * `{ ok: false }`, never thrown.
 */
export function parsePersistedFollowThroughPayload(
  payload: unknown
): { ok: true; value: EstimateClosingRecommendationFollowThrough } | { ok: false } {
  if (!isRecord(payload)) return { ok: false };
  if (typeof payload.recommendationEventId !== "string" || !payload.recommendationEventId) return { ok: false };
  if (typeof payload.actionTaken !== "string" || !ACTION_TAKEN_VALUES.has(payload.actionTaken)) return { ok: false };
  if (payload.actionChannel !== null && (typeof payload.actionChannel !== "string" || !ACTION_CHANNEL_VALUES.has(payload.actionChannel))) {
    return { ok: false };
  }
  // Structural coherence, re-checked on READ too (not just at write time) —
  // a hand-edited or pre-migration row must never be trusted into an
  // inconsistent shape either. See validateFollowThroughInput for the same
  // rule enforced at write time.
  if (payload.actionTaken === "yes" && payload.actionChannel === null) return { ok: false };
  if (payload.actionTaken !== "yes" && payload.actionChannel !== null) return { ok: false };
  if (typeof payload.customerResponse !== "string" || !CUSTOMER_RESPONSE_VALUES.has(payload.customerResponse)) return { ok: false };
  if (typeof payload.businessDisposition !== "string" || !BUSINESS_DISPOSITION_VALUES.has(payload.businessDisposition)) return { ok: false };

  return {
    ok: true,
    value: {
      recommendationEventId: payload.recommendationEventId,
      actionTaken: payload.actionTaken as FollowThroughActionTaken,
      actionChannel: (payload.actionChannel ?? null) as FollowThroughActionChannel | null,
      customerResponse: payload.customerResponse as FollowThroughCustomerResponse,
      businessDisposition: payload.businessDisposition as FollowThroughBusinessDisposition,
    },
  };
}
