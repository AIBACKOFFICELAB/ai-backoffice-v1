/**
 * Business Event System types (P0.5). See docs/EVENT_SYSTEM.md.
 *
 * A business event is the canonical, tenant-scoped record of "something
 * happened" — independent of which module or agent cares about it. Modules
 * keep their own module-scoped History tables (missed_call_recovery_history,
 * estimate_followup_history, ...) per docs/constitution/03_MODULE_ARCHITECTURE.md;
 * business events are the separate cross-module log the agent runtime
 * triggers off of and reconstructs against.
 */

export type EventActorType = "user" | "system" | "agent" | "integration";

export type BusinessEvent = {
  id: string;
  tenantId: string;
  eventType: string;
  actorType: EventActorType;
  actorId: string | null;
  entityType: string | null;
  entityId: string | null;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
};

export type EmitEventInput = {
  tenantId: string;
  eventType: string;
  actorType?: EventActorType;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Ties this event to others in the same logical chain of causation. */
  correlationId?: string;
  /** The id of the event/action that directly caused this one, if any. */
  causationId?: string | null;
  /**
   * Set this for any event whose source might redeliver (webhooks, cron
   * scans, queue retries) so emission is safe to call twice. Omit only for
   * events that are inherently unique on their own (e.g. a fresh UUID per
   * call already guarantees uniqueness upstream).
   */
  idempotencyKey?: string | null;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  /** Defaults to now(); set explicitly when replaying/backfilling. */
  occurredAt?: string;
};

/**
 * Canonical event-type vocabulary this codebase currently emits or plans to.
 * Not a hard enum at the DB layer (schema stores event_type as free text —
 * new event types must not require a migration) but centralized here so
 * producers and future consumers agree on spelling.
 */
export const KNOWN_EVENT_TYPES = [
  "lead.created",
  "lead.updated",
  "call.missed",
  "call.recovered",
  /** P0.9 Slice C (finding H-03): emitted when a recovery SMS is
   * successfully SENT — an operational fact, never a claim that the
   * customer re-engaged. "call.recovered" remains reserved for a future
   * evidence-based recovery signal (an inbound reply, a booked
   * appointment, ...) once such a path exists — see
   * lib/modules/missedCallRecovery/service.ts and
   * docs/OUTCOME_ATTRIBUTION.md. */
  "recovery.sms_sent",
  "customer.replied",
  "estimate.created",
  "estimate.sent",
  "estimate.viewed",
  "estimate.stalled",
  /** P1A: emitted by the Estimate Closing Agent (Shadow Mode) after it
   * reasons about a stalled estimate — never by a page render, never on
   * every scan. Payload is the privacy-safe, structured
   * EstimateClosingRecommendation (see lib/agents/estimateClosing/types.ts)
   * — no raw model prose, no customer PII. See
   * lib/agents/estimateClosing/shadowRunner.ts. */
  "estimate.closing_recommendation_generated",
  /** P1 Sprint 3: emitted when the tenant owner records a verdict on a
   * previously-generated shadow recommendation — evaluation EVIDENCE, never
   * an outcome, never a customer action. actorType is "user" (a human
   * reviewed it), not "agent" — the opposite of the event it reviews. See
   * lib/agents/estimateClosing/review.ts, the only writer. Enumerated
   * feedback only: verdict/wouldAct/reasonCodes, no free text, no PII. */
  "estimate.closing_recommendation_reviewed",
  /** P1 Sprint 5: durable, tenant-scoped OPERATIONAL heartbeat for the
   * Estimate Closing scan cron — emitted once per relevant (registered AND
   * active) tenant every time the scan actually runs, INCLUDING a tenant
   * with zero candidates that sweep. Closes the "cron ran and found
   * nothing" vs. "cron never ran" observability gap — never an agent run,
   * never a recommendation, never an outcome. See
   * lib/agents/estimateClosing/scanTelemetry.ts, the only writer. */
  "estimate.closing_scan_completed",
  /** P1 Sprint 5: sanitized, tenant-scoped record of a SCAN-level failure
   * (the candidate read itself threw) — a fixed error category only, never
   * raw error text. See lib/agents/estimateClosing/scanTelemetry.ts. */
  "estimate.closing_scan_failed",
  /** P1 Sprint 6: an OWNER-RECORDED observation of what happened after a
   * shadow recommendation — did they act, how, did the customer respond,
   * what is the current business result. Never an approval, never an agent
   * action, never an outcome, never recovered revenue. actorType is "user"
   * (a human recorded it). Multiple events of this type can exist per
   * recommendation (append-only corrections) — the most recent one wins;
   * see lib/agents/estimateClosing/followThrough.ts, the only writer. */
  "estimate.closing_recommendation_followthrough_recorded",
  "job.created",
  "job.completed",
  "invoice.created",
  "invoice.overdue",
  "payment.received",
  "review.requested",
  "test.echo",
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];
