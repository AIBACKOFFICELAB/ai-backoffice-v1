import { PlumbingLead, LeadStatus } from "@/data/leadModel";
import { emitEvent } from "@/lib/events/service";
import { SupabaseBusinessEventStore } from "@/lib/events/store";
import { enrollLeadInFollowup } from "@/lib/modules/estimateFollowup/service";

/**
 * P1 Sprint 4 — the canonical "estimate was sent" transition. See
 * AUTH... no — see the P1 Sprint 4 directive's Gate 2 audit (PR
 * description) for the full before/after: `PUT /api/leads/[id]`
 * (app/api/leads/[id]/route.ts) already triggers enrollment whenever
 * `status` becomes "Estimate Sent" — this module does NOT newly wire that
 * trigger, it hardens it: validates the estimate amount before anything is
 * written, makes enrollment idempotent against retries/concurrent
 * double-submits (reusing the existing `UNIQUE (tenant_id, lead_id)`
 * constraint on estimate_followup_sequences — migration 005 — no new
 * migration), and records a single, privacy-safe `estimate.sent` lifecycle
 * event (already reserved in lib/events/types.ts's KNOWN_EVENT_TYPES, never
 * previously emitted).
 *
 * Deliberately does NOT own the lead's own status/amount database write —
 * app/api/leads/[id]/route.ts already has exactly one write path
 * (lib/leads/repository.ts::updateLead, including its Google-Sheets
 * shadow-write fallback) and this module must not duplicate it (P1 Sprint 4
 * directive Gate 4: "Do NOT duplicate business logic across UI/API
 * routes"). validateEstimateSentTransition runs BEFORE that write (so an
 * invalid transition writes nothing at all); markEstimateSent runs AFTER
 * it, against the resulting lead row, and owns only the
 * validated/idempotent/event-emitting part: enroll exactly once, record
 * the fact exactly once.
 */

export type EstimateSentValidation =
  | { ok: true }
  | { ok: false; reason: "invalid_amount" }
  | { ok: false; reason: "terminal_status_refused" };

const TERMINAL_STATUSES: ReadonlySet<LeadStatus> = new Set<LeadStatus>(["Won", "Lost", "Completed"]);

/**
 * Pure precondition check — no I/O. Called BEFORE any database write, so a
 * refused transition (invalid amount, or the lead is already closed)
 * changes nothing. Deliberately permissive of a lead already sitting at
 * "Estimate Sent" (re-invoking the same transition is the idempotent-retry
 * case markEstimateSent below is built to handle safely, not an error) —
 * only Won/Lost/Completed are refused as genuinely terminal.
 */
export function validateEstimateSentTransition(currentStatus: LeadStatus, estimateAmount: number): EstimateSentValidation {
  if (TERMINAL_STATUSES.has(currentStatus)) {
    return { ok: false, reason: "terminal_status_refused" };
  }
  if (typeof estimateAmount !== "number" || !Number.isFinite(estimateAmount) || estimateAmount <= 0) {
    return { ok: false, reason: "invalid_amount" };
  }
  return { ok: true };
}

export type MarkEstimateSentOutcome =
  /** The lead's status transitioned to "Estimate Sent" as part of this
   * call, and the follow-up sequence was created for the first time. */
  | "newly_sent_enrolled"
  /** The lead was already "Estimate Sent" AND already had a sequence
   * (a plain idempotent retry), OR this call raced a concurrent request
   * that won the enrollment insert first — either way, the lead is
   * correctly Estimate-Sent + enrolled right now, and this call created
   * nothing new. */
  | "already_sent_enrolled"
  /** The lead was already "Estimate Sent" but had NO sequence — a past
   * enrollment gap (see the PR's Gate 2 audit, item C) — and THIS call is
   * what created it. Distinguished from newly_sent_enrolled purely for
   * honest telemetry: no status transition happened here, only a
   * reconciling enrollment. */
  | "already_sent_reconciled"
  /** The status/amount write (if any) is not this function's concern —
   * enrollment itself failed for a genuine, non-constraint reason. The
   * lead's own status change (performed by the caller before invoking this
   * function) is NOT rolled back; see estimateLifecycleReadModel.ts's
   * "Estimate Sent without sequence" diagnostic, which is exactly what
   * exists to catch this case in production rather than hiding it. */
  | "enrollment_failed";

export type MarkEstimateSentResult = {
  outcome: MarkEstimateSentOutcome;
  leadId: string;
  sequenceCreated: boolean;
};

export interface MarkEstimateSentDeps {
  enrollLeadInFollowup(tenantId: string, lead: PlumbingLead): Promise<{ enrolled: boolean; reason?: string; error?: string }>;
  emitLifecycleEvent(input: {
    tenantId: string;
    leadId: string;
    estimateAmount: number;
    sequenceCreated: boolean;
    actorUserId: string | null;
  }): Promise<void>;
}

export function buildEstimateSentIdempotencyKey(leadId: string): string {
  return `estimate.sent:${leadId}`;
}

/** The real, production deps — a thin adapter over the existing
 * enrollLeadInFollowup and the business-event system. Kept separate from
 * markEstimateSent itself so tests can inject a fake without touching
 * Supabase. */
export function createLiveMarkEstimateSentDeps(): MarkEstimateSentDeps {
  return {
    enrollLeadInFollowup,
    async emitLifecycleEvent({ tenantId, leadId, estimateAmount, sequenceCreated, actorUserId }) {
      await emitEvent(
        {
          tenantId,
          eventType: "estimate.sent",
          actorType: "user",
          actorId: actorUserId,
          entityType: "lead",
          entityId: leadId,
          idempotencyKey: buildEstimateSentIdempotencyKey(leadId),
          payload: { estimateAmount, sequenceCreated },
        },
        new SupabaseBusinessEventStore()
      );
    },
  };
}

/**
 * Ensures `lead` (already validated by validateEstimateSentTransition and
 * already persisted at status "Estimate Sent" by the caller) is enrolled in
 * the Day 1/3/7 follow-up sequence exactly once, and that the fact is
 * recorded exactly once — safe to call for a brand-new transition, a plain
 * retry, a concurrent double-submit, or a reconciling re-check of a lead
 * that's been "Estimate Sent" for a while. `wasAlreadyEstimateSent` tells
 * this function whether the CALLER just performed the status transition
 * (false) or found the lead already at that status (true) — purely for
 * honest outcome telemetry, it does not change what this function does.
 */
export async function markEstimateSent(
  lead: PlumbingLead,
  tenantId: string,
  wasAlreadyEstimateSent: boolean,
  actorUserId: string | null,
  deps: MarkEstimateSentDeps
): Promise<MarkEstimateSentResult> {
  const enrollResult = await deps.enrollLeadInFollowup(tenantId, lead);
  const sequenceCreated = enrollResult.enrolled === true;

  let outcome: MarkEstimateSentOutcome;
  if (sequenceCreated) {
    outcome = wasAlreadyEstimateSent ? "already_sent_reconciled" : "newly_sent_enrolled";
  } else if (enrollResult.reason === "already-enrolled") {
    outcome = "already_sent_enrolled";
  } else {
    outcome = "enrollment_failed";
  }

  if (outcome !== "enrollment_failed") {
    await deps.emitLifecycleEvent({
      tenantId,
      leadId: lead.id,
      estimateAmount: lead.estimateAmount,
      sequenceCreated,
      actorUserId,
    });
  }

  return { outcome, leadId: lead.id, sequenceCreated };
}
