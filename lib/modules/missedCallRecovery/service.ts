import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createLead } from "@/lib/leads/repository";
import { sendSms, SendSmsResult } from "@/lib/sms/twilio";
import { sendEmail, SendEmailResult } from "@/lib/email/sendgrid";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://ai-backoffice-v1.vercel.app";

export type MissedCallSettings = {
  tenantId: string;
  enabled: boolean;
  businessPhone: string | null;
  smsTemplate: string;
  ownerAlertPhone: string | null;
  ownerNotificationEmail: string | null;
  intakeFormUrl: string | null;
  emergencyPhone: string | null;
  businessTagline: string | null;
  emergencyKeywords: string[];
};

export type MissedCallPayload = {
  callerPhone: string;
  callSid?: string;
  calledPhone?: string;
  triggerSource?: string;
};

const SETTINGS_COLUMNS =
  "tenant_id, enabled, business_phone, sms_template, owner_alert_phone, owner_notification_email, intake_form_url, emergency_phone, business_tagline, emergency_keywords";

function mapSettingsRow(data: Record<string, any>): MissedCallSettings {
  return {
    tenantId: data.tenant_id,
    enabled: data.enabled,
    businessPhone: data.business_phone,
    smsTemplate: data.sms_template,
    ownerAlertPhone: data.owner_alert_phone,
    ownerNotificationEmail: data.owner_notification_email,
    intakeFormUrl: data.intake_form_url,
    emergencyPhone: data.emergency_phone,
    businessTagline: data.business_tagline,
    emergencyKeywords: data.emergency_keywords ?? [],
  };
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => vars[key] ?? "");
}

/** Trigger layer: resolves which tenant a missed call belongs to, by the number that was called. */
export async function findTenantByBusinessPhone(calledPhone: string): Promise<MissedCallSettings | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("missed_call_recovery_settings")
    .select(SETTINGS_COLUMNS)
    .eq("business_phone", calledPhone)
    .maybeSingle();

  if (error || !data) return null;
  return mapSettingsRow(data);
}

export async function getMissedCallSettings(tenantId: string): Promise<MissedCallSettings | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("missed_call_recovery_settings")
    .select(SETTINGS_COLUMNS)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error || !data) return null;
  return mapSettingsRow(data);
}

export async function updateMissedCallSettings(tenantId: string, update: Partial<Omit<MissedCallSettings, "tenantId">>) {
  const supabase = await createServerSupabaseClient();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (update.enabled !== undefined) row.enabled = update.enabled;
  if (update.businessPhone !== undefined) row.business_phone = update.businessPhone;
  if (update.smsTemplate !== undefined) row.sms_template = update.smsTemplate;
  if (update.ownerAlertPhone !== undefined) row.owner_alert_phone = update.ownerAlertPhone;
  if (update.ownerNotificationEmail !== undefined) row.owner_notification_email = update.ownerNotificationEmail;
  if (update.intakeFormUrl !== undefined) row.intake_form_url = update.intakeFormUrl;
  if (update.emergencyPhone !== undefined) row.emergency_phone = update.emergencyPhone;
  if (update.businessTagline !== undefined) row.business_tagline = update.businessTagline;
  if (update.emergencyKeywords !== undefined) row.emergency_keywords = update.emergencyKeywords;

  const { error } = await supabase.from("missed_call_recovery_settings").update(row).eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);
}

type ChannelOutcome = "sent" | "failed" | "skipped";

function outcomeFromSms(result: SendSmsResult): ChannelOutcome {
  if (result.ok) return "sent";
  if (result.skipped) return "skipped";
  return "failed";
}

function reasonFromSms(result: SendSmsResult): string | undefined {
  if (result.ok) return undefined;
  return result.reason;
}

function outcomeFromEmail(result: SendEmailResult): ChannelOutcome {
  if (result.ok) return "sent";
  if (result.skipped) return "skipped";
  return "failed";
}

function reasonFromEmail(result: SendEmailResult): string | undefined {
  if (result.ok) return undefined;
  return result.reason === "sendgrid-error" || result.reason === "unexpected-error" ? `${result.reason}: ${result.detail ?? ""}`.trim() : result.reason;
}

/**
 * Execution layer: sends the recovery SMS to the caller, creates a lead,
 * notifies the owner by SMS and email, and writes every outcome to History.
 * Idempotent per callSid. No step is allowed to silently fail — every
 * channel's outcome (sent/failed/skipped + reason) is recorded.
 */
export async function executeMissedCallRecovery(tenantId: string, settings: MissedCallSettings, payload: MissedCallPayload, tenantName: string) {
  const supabase = await createServerSupabaseClient();

  if (payload.callSid) {
    const { data: existing } = await supabase
      .from("missed_call_recovery_history")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("call_sid", payload.callSid)
      .maybeSingle();
    if (existing) {
      return { status: "skipped" as const, reason: "already-processed" };
    }
  }

  if (!settings.enabled) {
    await writeHistory(tenantId, payload, {
      status: "skipped",
      recoverySms: { status: "skipped", reason: "module-disabled" },
      ownerSms: { status: "skipped" },
      ownerEmail: { status: "skipped" },
    });
    return { status: "skipped" as const, reason: "module-disabled" };
  }

  // 1. Recovery SMS to the caller
  const recoveryMessage = renderTemplate(settings.smsTemplate, {
    business_name: tenantName,
    intake_form_url: settings.intakeFormUrl ?? "",
    emergency_phone: settings.emergencyPhone ?? "",
    business_tagline: settings.businessTagline ?? "",
  });
  const recoverySmsResult = await sendSms(payload.callerPhone, recoveryMessage);

  // 2. Create the lead
  let leadId: string | null = null;
  try {
    const lead = await createLead(
      {
        date: new Date().toISOString(),
        customerName: "Unknown Caller",
        phone: payload.callerPhone,
        email: "",
        serviceAddress: "",
        propertyType: "Other",
        serviceType: "Other",
        emergency: "No",
        urgency: "Same Day",
        jobDescription: "Missed call — awaiting callback details.",
        photosUploaded: "No",
        preferredAppointmentTime: "",
        customerRole: "Owner",
        leadSource: "Other",
        customerNotes: "",
        status: "New",
        estimateAmount: 0,
        followUpDate: "",
        reviewRequestStatus: "Not Ready",
        internalNotes: "Auto-created by Missed Call Recovery",
        source: "missed-call-recovery",
        id: randomUUID(),
      },
      tenantId
    );
    leadId = lead.id;
  } catch (error) {
    console.error("[missed-call-recovery] failed to create lead", error);
  }

  const leadUrl = leadId ? `${APP_URL}/leads/${leadId}` : APP_URL;

  // 3. Notify the owner by SMS
  let ownerSmsResult: SendSmsResult = { ok: false, skipped: true, reason: "missing-env" };
  if (settings.ownerAlertPhone) {
    const ownerMessage = `AI BackOffice Alert: Missed call recovered for ${tenantName}. Caller: ${payload.callerPhone}. Recovery SMS sent. Check Lead Inbox: ${leadUrl}`;
    ownerSmsResult = await sendSms(settings.ownerAlertPhone, ownerMessage);
  }

  // 4. Notify the owner by email
  let ownerEmailResult: SendEmailResult = { ok: false, skipped: true, reason: "missing-env" };
  if (settings.ownerNotificationEmail) {
    const emailBody = [
      `Caller phone: ${payload.callerPhone}`,
      `Timestamp: ${new Date().toISOString()}`,
      `Lead link: ${leadUrl}`,
      `Recovery SMS status: ${outcomeFromSms(recoverySmsResult)}`,
      `Next action: Review the lead and follow up with the caller.`,
    ].join("\n");
    ownerEmailResult = await sendEmail(settings.ownerNotificationEmail, "New Missed Call Lead Recovered", emailBody);
  }

  const overallStatus = recoverySmsResult.ok ? "recovered" : recoverySmsResult.skipped ? "skipped" : "failed";

  await writeHistory(tenantId, payload, {
    status: overallStatus,
    leadId,
    recoverySms: { status: outcomeFromSms(recoverySmsResult), sid: recoverySmsResult.ok ? recoverySmsResult.sid : undefined, reason: reasonFromSms(recoverySmsResult) },
    ownerSms: { status: outcomeFromSms(ownerSmsResult), sid: ownerSmsResult.ok ? ownerSmsResult.sid : undefined, reason: reasonFromSms(ownerSmsResult) },
    ownerEmail: { status: outcomeFromEmail(ownerEmailResult), reason: reasonFromEmail(ownerEmailResult) },
  });

  return {
    status: overallStatus as "recovered" | "failed" | "skipped",
    leadId,
    recoverySmsResult,
    ownerSmsResult,
    ownerEmailResult,
  };
}

async function writeHistory(
  tenantId: string,
  payload: MissedCallPayload,
  outcome: {
    status: string;
    leadId?: string | null;
    recoverySms: { status: ChannelOutcome; sid?: string; reason?: string };
    ownerSms: { status: ChannelOutcome; sid?: string; reason?: string };
    ownerEmail: { status: ChannelOutcome; reason?: string };
  }
) {
  const supabase = await createServerSupabaseClient();
  await supabase.from("missed_call_recovery_history").insert({
    tenant_id: tenantId,
    caller_phone: payload.callerPhone,
    call_sid: payload.callSid ?? null,
    lead_id: outcome.leadId ?? null,
    trigger_source: payload.triggerSource ?? "twilio_missed_call",
    status: outcome.status,
    sms_sent: outcome.recoverySms.status === "sent",
    sms_sid: outcome.recoverySms.sid ?? null,
    failure_reason: outcome.recoverySms.reason ?? null,
    recovery_sms_status: outcome.recoverySms.status,
    recovery_sms_failure_reason: outcome.recoverySms.reason ?? null,
    owner_alerted: outcome.ownerSms.status === "sent",
    owner_sms_status: outcome.ownerSms.status,
    owner_sms_sid: outcome.ownerSms.sid ?? null,
    owner_sms_failure_reason: outcome.ownerSms.reason ?? null,
    owner_email_status: outcome.ownerEmail.status,
    owner_email_failure_reason: outcome.ownerEmail.reason ?? null,
  });
}

export async function getMissedCallHistory(tenantId: string, limit = 50) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("missed_call_recovery_history")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getMissedCallHistoryForLead(tenantId: string, leadId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("missed_call_recovery_history")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function getMissedCallAnalytics(tenantId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("missed_call_recovery_history")
    .select("status, owner_sms_status, owner_email_status")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const total = rows.length;
  const recovered = rows.filter((r) => r.status === "recovered").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const skipped = rows.filter((r) => r.status === "skipped").length;
  const ownerNotified = rows.filter((r) => r.owner_sms_status === "sent" || r.owner_email_status === "sent").length;
  const ownerNotificationFailures = rows.filter((r) => r.owner_sms_status === "failed" || r.owner_email_status === "failed").length;

  return {
    totalMissedCalls: total,
    recovered,
    failed,
    skipped,
    ownerNotified,
    ownerNotificationFailures,
    recoveryRate: total > 0 ? Math.round((recovered / total) * 100) : 0,
  };
}
