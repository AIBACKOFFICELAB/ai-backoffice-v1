import { createServerSupabaseClient } from "@/lib/supabase/server";
import { sendSms } from "@/lib/sms/twilio";
import { PlumbingLead } from "@/data/leadModel";

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

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => vars[key] ?? "");
}

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

/** Trigger layer: enroll a lead the moment its status becomes "Estimate Sent". */
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
  const { error } = await supabase.from("estimate_followup_sequences").insert({
    tenant_id: tenantId,
    lead_id: lead.id,
    estimate_sent_at: sentAt.toISOString(),
    day1_due_at: new Date(sentAt.getTime() + 1 * DAY_MS).toISOString(),
    day3_due_at: new Date(sentAt.getTime() + 3 * DAY_MS).toISOString(),
    day7_due_at: new Date(sentAt.getTime() + 7 * DAY_MS).toISOString(),
    status: "active",
  });

  if (error) {
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
  const steps: Array<{ key: "day1" | "day3" | "day7"; dueAt: string; sentAt: string | null; template: string }> = [
    { key: "day1", dueAt: seq.day1_due_at, sentAt: seq.day1_sent_at, template: settings.day1Template },
    { key: "day3", dueAt: seq.day3_due_at, sentAt: seq.day3_sent_at, template: settings.day3Template },
    { key: "day7", dueAt: seq.day7_due_at, sentAt: seq.day7_sent_at, template: settings.day7Template },
  ];

  const due = steps.find((s) => !s.sentAt && new Date(s.dueAt) <= now);
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
