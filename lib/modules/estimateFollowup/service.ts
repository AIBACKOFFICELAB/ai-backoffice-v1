import { createServerSupabaseClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms/twilio";
import { PlumbingLead } from "@/data/leadModel";
import { renderTemplate } from "@/lib/templates";

const DAY_MS = 24 * 60 * 60 * 1000;

export type EstimateFollowupSettings = {
  tenantId: string;
  enabled: boolean;
  day1Template: string;
  day3Template: string;
  day7Template: string;
  stopOnReply: boolean;
  stopOnStatusChange: boolean;
};

export async function getEstimateFollowupSettings(tenantId: string): Promise<EstimateFollowupSettings | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("estimate_followup_settings")
    .select("*")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return null;

  return {
    tenantId: data.tenant_id,
    enabled: data.enabled,
    day1Template: data.day1_template,
    day3Template: data.day3_template,
    day7Template: data.day7_template,
    stopOnReply: data.stop_on_reply,
    stopOnStatusChange: data.stop_on_status_change,
  };
}

export type FollowupAutomationStatus = "enabled" | "disabled" | "unknown";

/**
 * P1 Sprint 4 — distinguishes "we genuinely know it's off" from "we don't
 * know" (a real query/RLS error), unlike getEstimateFollowupSettings above,
 * which deliberately collapses BOTH a query error and a missing settings
 * row into the same `null` for its EXISTING callers (processSequence,
 * recordReplyForPhone) — that collapse is the CORRECT fail-safe direction
 * for a SENDING decision (never send when we can't confirm the setting).
 * A UI claim about whether messages WILL be sent needs the opposite
 * fail-safe direction: never confidently tell an owner "no automated
 * messages will be sent" when the truth is merely unknown right now — a
 * later cron run reads the real setting and may still send (Codex review
 * finding on PR #23, P1). Used only by app/(app)/leads/[id]/page.tsx's
 * display copy; every existing SENDING-decision call site is untouched.
 */
export async function getFollowupAutomationStatus(tenantId: string): Promise<FollowupAutomationStatus> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("estimate_followup_settings").select("enabled").eq("tenant_id", tenantId).maybeSingle();
  if (error) return "unknown";
  if (!data) return "disabled"; // no settings row for this tenant genuinely means the module has never been configured — the same fact processSequence's "module-disabled" skip reason reflects.
  return data.enabled ? "enabled" : "disabled";
}

export async function updateEstimateFollowupSettings(tenantId: string, update: Partial<Omit<EstimateFollowupSettings, "tenantId">>) {
  const supabase = await createServerSupabaseClient();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (update.enabled !== undefined) row.enabled = update.enabled;
  if (update.day1Template !== undefined) row.day1_template = update.day1Template;
  if (update.day3Template !== undefined) row.day3_template = update.day3Template;
  if (update.day7Template !== undefined) row.day7_template = update.day7Template;
  if (update.stopOnReply !== undefined) row.stop_on_reply = update.stopOnReply;
  if (update.stopOnStatusChange !== undefined) row.stop_on_status_change = update.stopOnStatusChange;

  const { error } = await supabase.from("estimate_followup_settings").update(row).eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);
}

export type FollowupDueDates = { day1DueAt: string; day3DueAt: string; day7DueAt: string };

/** Pure Day 1 / Day 3 / Day 7 due-date math, extracted from an inline
 * literal so it's regression-testable (see service.test.ts). Behavior is
 * unchanged. */
export function computeFollowupDueDates(sentAt: Date): FollowupDueDates {
  return {
    day1DueAt: new Date(sentAt.getTime() + 1 * DAY_MS).toISOString(),
    day3DueAt: new Date(sentAt.getTime() + 3 * DAY_MS).toISOString(),
    day7DueAt: new Date(sentAt.getTime() + 7 * DAY_MS).toISOString(),
  };
}

/** Postgres unique-violation error code — see
 * lib/events/store.ts::SupabaseBusinessEventStore.insert for the same
 * pattern already established in this codebase. */
const UNIQUE_VIOLATION = "23505";

/**
 * Trigger layer: enroll a lead the moment its status becomes
 * "Estimate Sent". Idempotent under real concurrency, not just the
 * pre-check above: `estimate_followup_sequences` has a
 * `UNIQUE (tenant_id, lead_id)` constraint (migration 005), so two
 * concurrent calls that both pass the pre-check above (a genuine TOCTOU
 * race) can still only ever result in ONE row — the loser's insert fails
 * with a unique-violation, which is recognized here and reported as the
 * same successful `already-enrolled` outcome as the pre-check case, never
 * as a generic failure (P1 Sprint 4 directive Gate 5: "concurrent
 * enrollment safe... never create duplicate sequences" — using the
 * existing DB constraint, no migration needed).
 */
export async function enrollLeadInFollowup(tenantId: string, lead: PlumbingLead) {
  const supabase = await createServerSupabaseClient();

  const { data: existing } = await supabase
    .from("estimate_followup_sequences")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("lead_id", lead.id)
    .maybeSingle();

  if (existing) {
    return { enrolled: false, reason: "already-enrolled" as const };
  }

  const sentAt = new Date();
  const dueDates = computeFollowupDueDates(sentAt);
  const { error } = await supabase.from("estimate_followup_sequences").insert({
    tenant_id: tenantId,
    lead_id: lead.id,
    estimate_sent_at: sentAt.toISOString(),
    day1_due_at: dueDates.day1DueAt,
    day3_due_at: dueDates.day3DueAt,
    day7_due_at: dueDates.day7DueAt,
    status: "active",
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return { enrolled: false, reason: "already-enrolled" as const };
    }
    return { enrolled: false, reason: "insert-failed" as const, error: error.message };
  }
  return { enrolled: true as const };
}

/** Reply detection: stop a lead's active sequence when an inbound SMS matches its phone. */
export async function recordReplyForPhone(tenantId: string, phone: string) {
  const supabase = await createServerSupabaseClient();

  const { data: lead } = await supabase
    .from("leads")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("phone", phone)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lead) return { matched: false as const };

  const { data: sequence } = await supabase
    .from("estimate_followup_sequences")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("lead_id", lead.id)
    .eq("status", "active")
    .maybeSingle();

  if (!sequence) return { matched: false as const };

  const settings = await getEstimateFollowupSettings(tenantId);
  if (settings && !settings.stopOnReply) {
    await writeHistory(tenantId, sequence.id, lead.id, "reply_detected", { channel: "sms" });
    return { matched: true as const, stopped: false };
  }

  await supabase
    .from("estimate_followup_sequences")
    .update({ status: "replied", last_reply_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", sequence.id);

  await writeHistory(tenantId, sequence.id, lead.id, "reply_detected", { channel: "sms" });

  return { matched: true as const, stopped: true };
}

/** Execution layer: scan every tenant's active sequences and send whichever day-step is due. */
export async function processDueFollowups() {
  const supabase = await createServerSupabaseClient();
  const now = new Date().toISOString();

  const { data: sequences, error } = await supabase
    .from("estimate_followup_sequences")
    .select("*, leads:lead_id (customer_name, service_type, phone, status)")
    .eq("status", "active")
    .or(`and(day1_sent_at.is.null,day1_due_at.lte.${now}),and(day3_sent_at.is.null,day3_due_at.lte.${now}),and(day7_sent_at.is.null,day7_due_at.lte.${now})`);

  if (error) throw new Error(error.message);

  const results = [];
  for (const seq of sequences ?? []) {
    results.push(await processSequence(seq));
  }
  return results;
}

export type FollowupStep = { key: "day1" | "day3" | "day7"; dueAt: string; sentAt: string | null; template: string };

/** Selects the earliest not-yet-sent step whose due date has passed.
 * Extracted from an inline `.find()` for regression testing — behavior is
 * unchanged. */
export function selectDueStep(steps: FollowupStep[], now: Date): FollowupStep | undefined {
  return steps.find((s) => !s.sentAt && new Date(s.dueAt) <= now);
}

async function processSequence(seq: Record<string, any>) {
  const supabase = await createServerSupabaseClient();
  const settings = await getEstimateFollowupSettings(seq.tenant_id);
  if (!settings || !settings.enabled) {
    return { leadId: seq.lead_id, action: "skipped", reason: "module-disabled" };
  }

  const lead = Array.isArray(seq.leads) ? seq.leads[0] : seq.leads;
  if (!lead) {
    return { leadId: seq.lead_id, action: "skipped", reason: "lead-missing" };
  }

  if (settings.stopOnStatusChange && lead.status !== "Estimate Sent") {
    await supabase
      .from("estimate_followup_sequences")
      .update({ status: "stopped", stopped_reason: "status-changed", updated_at: new Date().toISOString() })
      .eq("id", seq.id);
    await writeHistory(seq.tenant_id, seq.id, seq.lead_id, "stopped", { channel: "sms" });
    return { leadId: seq.lead_id, action: "stopped", reason: "status-changed" };
  }

  const now = new Date();
  const steps: FollowupStep[] = [
    { key: "day1", dueAt: seq.day1_due_at, sentAt: seq.day1_sent_at, template: settings.day1Template },
    { key: "day3", dueAt: seq.day3_due_at, sentAt: seq.day3_sent_at, template: settings.day3Template },
    { key: "day7", dueAt: seq.day7_due_at, sentAt: seq.day7_sent_at, template: settings.day7Template },
  ];

  const due = selectDueStep(steps, now);
  if (!due) {
    return { leadId: seq.lead_id, action: "skipped", reason: "nothing-due" };
  }

  const message = renderTemplate(due.template, {
    customer_name: lead.customer_name ?? "there",
    service_type: lead.service_type ?? "your project",
  });

  const smsResult = await sendSms(lead.phone, message);

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  update[`${due.key}_sent_at`] = new Date().toISOString();
  if (due.key === "day7") {
    update.status = "completed";
  }
  await supabase.from("estimate_followup_sequences").update(update).eq("id", seq.id);

  await writeHistory(seq.tenant_id, seq.id, seq.lead_id, `${due.key}_sent` as const, {
    channel: "sms",
    messageBody: message,
    providerSid: smsResult.ok ? smsResult.sid : undefined,
    failureReason: !smsResult.ok ? smsResult.reason : undefined,
  });

  return { leadId: seq.lead_id, action: due.key, sent: smsResult.ok };
}

async function writeHistory(
  tenantId: string,
  sequenceId: string,
  leadId: string,
  eventType: "day1_sent" | "day3_sent" | "day7_sent" | "reply_detected" | "stopped" | "completed" | "send_failed",
  extra: { channel: "sms" | "email"; messageBody?: string; providerSid?: string; failureReason?: string }
) {
  const supabase = await createServerSupabaseClient();
  await supabase.from("estimate_followup_history").insert({
    tenant_id: tenantId,
    sequence_id: sequenceId,
    lead_id: leadId,
    event_type: extra.failureReason ? "send_failed" : eventType,
    channel: extra.channel,
    message_body: extra.messageBody ?? null,
    provider_sid: extra.providerSid ?? null,
    failure_reason: extra.failureReason ?? null,
  });
}

export async function getEstimateFollowupHistory(tenantId: string, limit = 50) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("estimate_followup_history")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export type FollowupSequenceRow = {
  id: string;
  leadId: string;
  status: "active" | "replied" | "completed" | "stopped";
  estimateSentAt: string;
  day1DueAt: string;
  day3DueAt: string;
  day7DueAt: string;
  day1SentAt: string | null;
  day3SentAt: string | null;
  day7SentAt: string | null;
  lastReplyAt: string | null;
  stoppedReason: string | null;
};

/**
 * P1 Sprint 4 — full sequence rows for a tenant (not just the `status`
 * column getEstimateFollowupAnalytics selects). Feeds
 * lib/leads/estimateLifecycleReadModel.ts, the dedicated read model for the
 * /estimates product surface — kept here, alongside the rest of this
 * module's tenant-scoped Supabase reads, rather than duplicated.
 */
export async function getEstimateFollowupSequencesForTenant(tenantId: string): Promise<FollowupSequenceRow[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("estimate_followup_sequences")
    .select("id, lead_id, status, estimate_sent_at, day1_due_at, day3_due_at, day7_due_at, day1_sent_at, day3_sent_at, day7_sent_at, last_reply_at, stopped_reason")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    status: row.status,
    estimateSentAt: row.estimate_sent_at,
    day1DueAt: row.day1_due_at,
    day3DueAt: row.day3_due_at,
    day7DueAt: row.day7_due_at,
    day1SentAt: row.day1_sent_at,
    day3SentAt: row.day3_sent_at,
    day7SentAt: row.day7_sent_at,
    lastReplyAt: row.last_reply_at,
    stoppedReason: row.stopped_reason,
  }));
}

export async function getEstimateFollowupAnalytics(tenantId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("estimate_followup_sequences")
    .select("status")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const total = rows.length;
  const replied = rows.filter((r) => r.status === "replied").length;
  const completed = rows.filter((r) => r.status === "completed").length;
  const active = rows.filter((r) => r.status === "active").length;
  const stopped = rows.filter((r) => r.status === "stopped").length;

  return {
    totalSequences: total,
    active,
    replied,
    completed,
    stopped,
    replyRate: total > 0 ? Math.round((replied / total) * 100) : 0,
  };
}
