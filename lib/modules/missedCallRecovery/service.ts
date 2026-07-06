import { randomUUID } from "crypto";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createLead } from "@/lib/leads/repository";
import { sendSms } from "@/lib/sms/twilio";

export type MissedCallSettings = {
  tenantId: string;
  enabled: boolean;
  businessPhone: string | null;
  smsTemplate: string;
  ownerAlertPhone: string | null;
  emergencyKeywords: string[];
};

export type MissedCallPayload = {
  callerPhone: string;
  callSid?: string;
  calledPhone?: string;
  triggerSource?: string;
};

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => vars[key] ?? "");
}

/** Trigger layer: resolves which tenant a missed call belongs to, by the number that was called. */
export async function findTenantByBusinessPhone(calledPhone: string): Promise<MissedCallSettings | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("missed_call_recovery_settings")
    .select("tenant_id, enabled, business_phone, sms_template, owner_alert_phone, emergency_keywords")
    .eq("business_phone", calledPhone)
    .maybeSingle();

  if (error || !data) return null;

  return {
    tenantId: data.tenant_id,
    enabled: data.enabled,
    businessPhone: data.business_phone,
    smsTemplate: data.sms_template,
    ownerAlertPhone: data.owner_alert_phone,
    emergencyKeywords: data.emergency_keywords ?? [],
  };
}

export async function getMissedCallSettings(tenantId: string): Promise<MissedCallSettings | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("missed_call_recovery_settings")
    .select("tenant_id, enabled, business_phone, sms_template, owner_alert_phone, emergency_keywords")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error || !data) return null;

  return {
    tenantId: data.tenant_id,
    enabled: data.enabled,
    businessPhone: data.business_phone,
    smsTemplate: data.sms_template,
    ownerAlertPhone: data.owner_alert_phone,
    emergencyKeywords: data.emergency_keywords ?? [],
  };
}

export async function updateMissedCallSettings(tenantId: string, update: Partial<Omit<MissedCallSettings, "tenantId">>) {
  const supabase = await createServerSupabaseClient();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (update.enabled !== undefined) row.enabled = update.enabled;
  if (update.businessPhone !== undefined) row.business_phone = update.businessPhone;
  if (update.smsTemplate !== undefined) row.sms_template = update.smsTemplate;
  if (update.ownerAlertPhone !== undefined) row.owner_alert_phone = update.ownerAlertPhone;
  if (update.emergencyKeywords !== undefined) row.emergency_keywords = update.emergencyKeywords;

  const { error } = await supabase.from("missed_call_recovery_settings").update(row).eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);
}

/** Execution layer: sends the recovery SMS, creates a lead, writes History. Idempotent per callSid. */
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
    await writeHistory(tenantId, payload, { status: "skipped", failureReason: "module-disabled" });
    return { status: "skipped" as const, reason: "module-disabled" };
  }

  const message = renderTemplate(settings.smsTemplate, { business_name: tenantName });
  const smsResult = await sendSms(payload.callerPhone, message);

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

  await writeHistory(tenantId, payload, {
    status: smsResult.ok ? "recovered" : smsResult.skipped ? "skipped" : "failed",
    smsSent: smsResult.ok,
    smsSid: smsResult.ok ? smsResult.sid : undefined,
    leadId,
    failureReason: !smsResult.ok ? smsResult.reason : undefined,
  });

  return { status: smsResult.ok ? ("recovered" as const) : ("failed" as const), leadId, smsResult };
}

async function writeHistory(
  tenantId: string,
  payload: MissedCallPayload,
  outcome: { status: string; smsSent?: boolean; smsSid?: string; leadId?: string | null; failureReason?: string }
) {
  const supabase = await createServerSupabaseClient();
  await supabase.from("missed_call_recovery_history").insert({
    tenant_id: tenantId,
    caller_phone: payload.callerPhone,
    call_sid: payload.callSid ?? null,
    lead_id: outcome.leadId ?? null,
    trigger_source: payload.triggerSource ?? "twilio_missed_call",
    sms_sent: outcome.smsSent ?? false,
    sms_sid: outcome.smsSid ?? null,
    status: outcome.status,
    failure_reason: outcome.failureReason ?? null,
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

export async function getMissedCallAnalytics(tenantId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("missed_call_recovery_history")
    .select("status")
    .eq("tenant_id", tenantId);
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const total = rows.length;
  const recovered = rows.filter((r) => r.status === "recovered").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const skipped = rows.filter((r) => r.status === "skipped").length;

  return {
    totalMissedCalls: total,
    recovered,
    failed,
    skipped,
    recoveryRate: total > 0 ? Math.round((recovered / total) * 100) : 0,
  };
}
