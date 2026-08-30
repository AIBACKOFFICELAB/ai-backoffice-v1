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
};

export type StalledScanResult = {
  candidatesScanned: number;
  stalledFound: number;
  /** Only the events that were genuinely NEW this run (deduped: false) —
   * these, and only these, are what should go on to trigger a shadow
   * reasoning call (see runEstimateClosingShadowSweep below). A re-run
   * that finds the same estimate still stalled correctly reports it in
   * stalledFound but NOT here. */
  newlyEmitted: StalledEmission[];
};

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * Read-only scan + idempotent event emission. Never invokes the model
 * gateway itself — see runEstimateClosingShadowSweep, which layers that on
 * top of this function's `newlyEmitted` result.
 */
export async function scanForStalledEstimates(deps: StalledScanDeps = {}): Promise<StalledScanResult> {
  const reader = deps.reader ?? new SupabaseSequenceWithLeadReader();
  const eventStore = deps.eventStore ?? new SupabaseBusinessEventStore();
  const now = deps.now ?? new Date();

  const candidates = await reader.listCandidates();
  const newlyEmitted: StalledEmission[] = [];
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

    if (!deduped) {
      newlyEmitted.push({ tenantId: sequence.tenantId, eventId: event.id, lead, sequence });
    }
  }

  return { candidatesScanned: candidates.length, stalledFound, newlyEmitted };
}

export type ShadowSweepResult = {
  scan: StalledScanResult;
  shadowOutcomes: Array<{ emission: StalledEmission; outcome: EstimateClosingShadowOutcome }>;
};

/**
 * Top-level entry point: scan for newly-stalled estimates, then — for each
 * one, and ONLY for each one (never for an already-known stalled estimate
 * a prior run already handled) — invoke the shadow agent. This is what
 * app/api/agents/estimate-closing/scan/route.ts calls.
 */
export async function runEstimateClosingShadowSweep(
  scanDeps: StalledScanDeps = {},
  shadowDeps: EstimateClosingShadowDeps = {}
): Promise<ShadowSweepResult> {
  const scan = await scanForStalledEstimates(scanDeps);

  const shadowOutcomes: Array<{ emission: StalledEmission; outcome: EstimateClosingShadowOutcome }> = [];
  for (const emission of scan.newlyEmitted) {
    const outcome = await triggerEstimateClosingShadow(emission.tenantId, emission.eventId, emission.lead, emission.sequence, shadowDeps);
    shadowOutcomes.push({ emission, outcome });
  }

  return { scan, shadowOutcomes };
}
