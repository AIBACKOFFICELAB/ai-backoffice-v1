import { createServerSupabaseClient } from "@/lib/supabase/server";
import { emitEvent } from "@/lib/events/service";
import { BusinessEventStore, SupabaseBusinessEventStore } from "@/lib/events/store";
import { isEstimateStalled } from "./eligibility";
import { triggerEstimateClosingShadow, EstimateClosingShadowDeps, EstimateClosingShadowOutcome } from "./shadowRunner";
import { EstimateClosingLeadContext, EstimateFollowupSequenceContext } from "./types";
import { LeadStatus } from "@/data/leadModel";

/**
 * P1A trigger layer — finds stalled estimates and wires them into the
 * shadow agent. Deliberately separate from
 * lib/modules/estimateFollowup/service.ts::processDueFollowups() (the
 * existing SMS-sending cron entry point): this file is read-only against
 * `leads`/`estimate_followup_sequences` and never touches the Estimate
 * Follow-up module's own send logic, so nothing here can affect a real
 * customer-facing SMS. See app/api/agents/estimate-closing/scan/route.ts
 * for the (not-yet-cron-wired) HTTP entry point, and featureFlag.ts for
 * why this stays inert in production today.
 *
 * "Do not use the dashboard as the event producer. Do not generate
 * duplicate stalled events every page load" (P1 directive §7): this is
 * only ever invoked from the scan route, never from a page render, and
 * every emitted estimate.stalled event carries a stable, sequence-derived
 * idempotencyKey (see buildStalledIdempotencyKey) — a re-run scan sees the
 * DB's own unique index return the ORIGINAL event (deduped: true), so a
 * given estimate can only ever produce one estimate.stalled event, ever,
 * no matter how many times the scan runs.
 */

export interface SequenceWithLeadReader {
  /** Every estimate_followup_sequences row whose status is still 'active'
   * or 'completed' (i.e. not yet resolved by a reply or an explicit stop),
   * joined with its lead's narrow, PII-free context. */
  listCandidates(): Promise<Array<{ sequence: EstimateFollowupSequenceContext; lead: EstimateClosingLeadContext }>>;
}

const SCANNABLE_SEQUENCE_STATUSES = ["active", "completed"] as const;

export class SupabaseSequenceWithLeadReader implements SequenceWithLeadReader {
  async listCandidates(): Promise<Array<{ sequence: EstimateFollowupSequenceContext; lead: EstimateClosingLeadContext }>> {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase
      .from("estimate_followup_sequences")
      .select(
        "id, tenant_id, lead_id, status, estimate_sent_at, day7_due_at, last_reply_at, leads:lead_id (id, tenant_id, status, estimate_amount, service_type, lead_source, urgency)"
      )
      .in("status", SCANNABLE_SEQUENCE_STATUSES);

    if (error) throw new Error(`[estimate-closing] stalled scan read failed: ${error.message}`);

    const rows: Array<{ sequence: EstimateFollowupSequenceContext; lead: EstimateClosingLeadContext }> = [];
    for (const row of data ?? []) {
      const leadRow = Array.isArray(row.leads) ? row.leads[0] : row.leads;
      if (!leadRow) continue; // orphaned sequence row — nothing to evaluate

      rows.push({
        sequence: {
          id: row.id,
          tenantId: row.tenant_id,
          leadId: row.lead_id,
          status: row.status,
          estimateSentAt: row.estimate_sent_at,
          day7DueAt: row.day7_due_at,
          lastReplyAt: row.last_reply_at,
        },
        lead: {
          id: leadRow.id,
          tenantId: leadRow.tenant_id,
          status: leadRow.status as LeadStatus,
          estimateAmount: leadRow.estimate_amount,
          serviceType: leadRow.service_type,
          leadSource: leadRow.lead_source,
          urgency: leadRow.urgency,
        },
      });
    }
    return rows;
  }
}

export class InMemorySequenceWithLeadReader implements SequenceWithLeadReader {
  constructor(private readonly rows: Array<{ sequence: EstimateFollowupSequenceContext; lead: EstimateClosingLeadContext }>) {}
  async listCandidates() {
    return this.rows;
  }
}

/** Stable per-estimate identity: an estimate_followup_sequences row can only
 * ever exist once per lead (enrollLeadInFollowup refuses re-enrollment —
 * see lib/modules/estimateFollowup/service.ts), so keying on the sequence
 * id alone is sufficient to guarantee at most one estimate.stalled event
 * per estimate, ever — never derived from the current time. */
export function buildStalledIdempotencyKey(sequenceId: string): string {
  return `estimate.stalled:${sequenceId}`;
}

export type StalledScanDeps = {
  reader?: SequenceWithLeadReader;
  eventStore?: BusinessEventStore;
  now?: Date;
};

export type StalledEmission = {
  tenantId: string;
  eventId: string;
  lead: EstimateClosingLeadContext;
  sequence: EstimateFollowupSequenceContext;
  /** Whether THIS scan run is what created the estimate.stalled event
   * (true) vs. found one already emitted by a previous run (false) — pure
   * telemetry; both cases are attempted identically by
   * runEstimateClosingShadowSweep (see below). */
  isNewEvent: boolean;
};

export type StalledScanResult = {
  candidatesScanned: number;
  stalledFound: number;
  /** Every currently-stalled candidate, whether its estimate.stalled event
   * was newly emitted by this run or already existed from a previous one.
   * runEstimateClosingShadowSweep attempts shadow reasoning for ALL of
   * these — it is triggerEstimateClosingShadow's OWN
   * `hasSucceededRun` check (not event-emission dedup) that prevents a
   * repeat model call for an estimate already successfully processed, so
   * a transient failure or a tenant not yet activated at scan time can
   * still be retried by a later scan instead of permanently losing its
   * one-time, non-re-emittable trigger event. */
  stalledCandidates: StalledEmission[];
};

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * Read-only scan + idempotent event emission. Never invokes the model
 * gateway itself — see runEstimateClosingShadowSweep, which layers that on
 * top of this function's `stalledCandidates` result.
 */
export async function scanForStalledEstimates(deps: StalledScanDeps = {}): Promise<StalledScanResult> {
  const reader = deps.reader ?? new SupabaseSequenceWithLeadReader();
  const eventStore = deps.eventStore ?? new SupabaseBusinessEventStore();
  const now = deps.now ?? new Date();

  const candidates = await reader.listCandidates();
  const stalledCandidates: StalledEmission[] = [];
  let stalledFound = 0;

  for (const { sequence, lead } of candidates) {
    if (!isEstimateStalled({ tenantId: sequence.tenantId, lead, sequence }, now)) continue;
    stalledFound += 1;

    const { event, deduped } = await emitEvent(
      {
        tenantId: sequence.tenantId,
        eventType: "estimate.stalled",
        actorType: "system",
        entityType: "lead",
        entityId: lead.id,
        idempotencyKey: buildStalledIdempotencyKey(sequence.id),
        payload: {
          sequenceId: sequence.id,
          estimateAmount: lead.estimateAmount,
          serviceType: lead.serviceType,
          daysSinceSent: daysBetween(new Date(sequence.estimateSentAt), now),
        },
      },
      eventStore
    );

    // Every currently-stalled candidate is tracked, whether this scan
    // created the event (deduped: false) or found one from a previous run
    // (deduped: true) — see the doc comment on StalledScanResult above for
    // why both are attempted identically downstream.
    stalledCandidates.push({ tenantId: sequence.tenantId, eventId: event.id, lead, sequence, isNewEvent: !deduped });
  }

  return { candidatesScanned: candidates.length, stalledFound, stalledCandidates };
}

export type ShadowSweepResult = {
  scan: StalledScanResult;
  shadowOutcomes: Array<{ emission: StalledEmission; outcome: EstimateClosingShadowOutcome }>;
};

/**
 * Top-level entry point: scan for currently-stalled estimates, then attempt
 * shadow reasoning for EVERY one of them — including an estimate whose
 * estimate.stalled event already existed from a previous run, so a
 * transient failure or an inactive/disabled tenant at the time of first
 * detection doesn't permanently forfeit its recommendation (see
 * shadowRunner.ts's 'already_processed' gate, which is what actually makes
 * repeat attempts for an already-succeeded estimate a safe no-op — this
 * function does not pre-filter on its own). This is what
 * app/api/agents/estimate-closing/scan/route.ts calls.
 */
export async function runEstimateClosingShadowSweep(
  scanDeps: StalledScanDeps = {},
  shadowDeps: EstimateClosingShadowDeps = {}
): Promise<ShadowSweepResult> {
  const scan = await scanForStalledEstimates(scanDeps);

  const shadowOutcomes: Array<{ emission: StalledEmission; outcome: EstimateClosingShadowOutcome }> = [];
  for (const emission of scan.stalledCandidates) {
    const outcome = await triggerEstimateClosingShadow(emission.tenantId, emission.eventId, emission.lead, emission.sequence, shadowDeps);
    shadowOutcomes.push({ emission, outcome });
  }

  return { scan, shadowOutcomes };
}
