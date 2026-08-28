/** Outcome + Revenue Attribution Foundation (P0.8). See docs/OUTCOME_ATTRIBUTION.md. */

export type OutcomeType =
  | "lead_recovered"
  | "appointment_booked"
  | "estimate_reengaged"
  | "estimate_won"
  | "revenue_recovered"
  | "invoice_collected"
  | "review_generated"
  | "admin_time_saved"
  | "other";

/**
 * How confident we are that the system (not just coincidence) caused this
 * outcome. Never default to DIRECT — see recordOutcome's validation.
 *
 * - direct: the system's action was the proximate cause (e.g. the recovery
 *   SMS the customer replied to, leading straight to a booked job).
 * - assisted: the system contributed materially but a human step also
 *   mattered (e.g. a follow-up reminder plus a phone call the owner made).
 * - inferred: outcome correlates with system activity but causation isn't
 *   directly observed (e.g. estimate marked "Won" during an active
 *   follow-up sequence, no reply logged).
 * - unknown: recorded for completeness; do not surface in ROI totals.
 */
export type AttributionConfidence = "direct" | "assisted" | "inferred" | "unknown";

export type Outcome = {
  id: string;
  tenantId: string;
  workflowId: string | null;
  agentRunId: string | null;
  entityType: string | null;
  entityId: string | null;
  outcomeType: OutcomeType;
  outcomeValue: number | null;
  currency: string;
  attributionConfidence: AttributionConfidence;
  occurredAt: string;
  metadata: Record<string, unknown>;
  /** P0.9 Slice C, finding C.3: derived from stable EVIDENCE identity, not
   * current time — e.g. `lead-recovered:<leadId>:<evidenceType>:<evidenceId>`
   * for a future real lead_recovered outcome. A repeated webhook, event
   * replay, retry, or compatibility callback for the SAME logical evidence
   * must not create a duplicate outcome. Null when no such stable identity
   * exists yet (the caller isn't required to invent one). See
   * db/migrations/019_p0_production_compatibility_privacy.sql. */
  idempotencyKey: string | null;
  createdAt: string;
};

export type RecordOutcomeInput = {
  tenantId: string;
  workflowId?: string | null;
  agentRunId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  outcomeType: OutcomeType;
  outcomeValue?: number | null;
  currency?: string;
  attributionConfidence: AttributionConfidence;
  occurredAt?: string;
  metadata?: Record<string, unknown>;
  /** See Outcome.idempotencyKey above. Omit only when no stable evidence
   * identity is available — never derive one from the current timestamp. */
  idempotencyKey?: string | null;
};
