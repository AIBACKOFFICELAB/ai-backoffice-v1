import { createServerSupabaseClient } from "@/lib/supabase/server";
import { BOOKING_CONFIRMATION_FOLLOW_UP } from "./booking";

export type CallSummaryRow = {
  id: string;
  created_at: string;
  status: string;
  priority: string | null;
  service_category: string | null;
  booking_outcome: string | null;
  escalation_result: string | null;
  escalation_reason: string | null;
  duration_seconds: number | null;
  provider_cost_usd: number | string | null;
  failure_category: string | null;
  lead_id: string | null;
  intake: { customerName?: string } | null;
};

export type RevenueDeskSummary = {
  calls: number;
  booked: number;
  escalated: number;
  failed: number;
  minutes: number;
  costUsd: number | null;
  costPerMinute: number | null;
};

/** Pure aggregation (unit-tested). Cost is only reported when the provider supplied it. */
export function summarizeCalls(rows: CallSummaryRow[]): RevenueDeskSummary {
  const seconds = rows.reduce((s, r) => s + (r.duration_seconds ?? 0), 0);
  const costed = rows.filter((r) => r.provider_cost_usd != null);
  const cost = costed.reduce((s, r) => s + Number(r.provider_cost_usd), 0);
  const costedSeconds = costed.reduce((s, r) => s + (r.duration_seconds ?? 0), 0);
  return {
    calls: rows.length,
    booked: rows.filter((r) => r.booking_outcome === "confirmed").length,
    escalated: rows.filter((r) => r.status === "escalated" || r.escalation_result != null).length,
    failed: rows.filter((r) => r.status === "failed" || r.failure_category != null).length,
    minutes: Math.round((seconds / 60) * 10) / 10,
    costUsd: costed.length ? Math.round(cost * 100) / 100 : null,
    costPerMinute: costed.length && costedSeconds > 0 ? Math.round((cost / (costedSeconds / 60)) * 1000) / 1000 : null,
  };
}

/** Pure: the owner action a call still carries, if any. The receptionist only
 * promises a callback after this is durably recorded on the call. */
export function ownerFollowUp(call: { escalation_reason: string | null }): { label: string; detail: string } | null {
  if (call.escalation_reason === BOOKING_CONFIRMATION_FOLLOW_UP) {
    return { label: "Call back to confirm booking", detail: "The appointment could not be confirmed during the call. The caller was told the team would call back to confirm it — check the booking attempts below, then call the customer." };
  }
  return null;
}

/** Founder-approved Founder Beta allowance (2026-10-06): 500 inbound minutes/month
 * included in $299/month. Metering + surfacing ONLY — no overage billing, no cutoff. */
export const FOUNDER_BETA_INCLUDED_MINUTES = 500;
export const ALLOWANCE_WARNING_RATIO = 0.8;

export type AllowanceStatus = { includedMinutes: number; usedMinutes: number; percentUsed: number; state: "within" | "approaching" | "exceeded"; monthStart: string };

/** Pure: usage for the current calendar month (UTC) against the allowance. */
export function computeAllowance(rows: Array<Pick<CallSummaryRow, "created_at" | "duration_seconds">>, now: Date = new Date()): AllowanceStatus {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const seconds = rows.filter((r) => Date.parse(r.created_at) >= monthStart.getTime()).reduce((s, r) => s + (r.duration_seconds ?? 0), 0);
  const usedMinutes = Math.round((seconds / 60) * 10) / 10;
  const ratio = usedMinutes / FOUNDER_BETA_INCLUDED_MINUTES;
  return {
    includedMinutes: FOUNDER_BETA_INCLUDED_MINUTES,
    usedMinutes,
    percentUsed: Math.round(ratio * 1000) / 10,
    state: ratio >= 1 ? "exceeded" : ratio >= ALLOWANCE_WARNING_RATIO ? "approaching" : "within",
    monthStart: monthStart.toISOString(),
  };
}

const SUMMARY_COLS = "id, created_at, status, priority, service_category, booking_outcome, escalation_result, escalation_reason, duration_seconds, provider_cost_usd, failure_category, lead_id, intake";

/** Operator view: every tenant's month-to-date usage (service-role caller only). */
export async function getAllowanceForTenant(tenantId: string) {
  const db = await createServerSupabaseClient();
  const now = new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { data, error } = await db.from("revenue_desk_calls").select("created_at, duration_seconds").eq("tenant_id", tenantId).gte("created_at", since);
  if (error) return null;
  return computeAllowance(data ?? [], now);
}

export async function getRevenueDeskOverview(tenantId: string) {
  const db = await createServerSupabaseClient();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime();
  const since = new Date(Math.min(Date.now() - 30 * 86400000, monthStart)).toISOString();
  const [settings, calls] = await Promise.all([
    db.from("revenue_desk_settings").select("enabled, booking_enabled, calendar_id, escalation_phone, vapi_phone_number_id").eq("tenant_id", tenantId).maybeSingle(),
    db.from("revenue_desk_calls").select(SUMMARY_COLS).eq("tenant_id", tenantId).gte("created_at", since).order("created_at", { ascending: false }).limit(5000),
  ]);
  if (calls.error) return { error: true as const };
  const rows = (calls.data ?? []) as CallSummaryRow[];
  const s = settings.data;
  return {
    error: false as const,
    status: !s ? "not_configured" : !s.enabled ? "disabled" : "enabled",
    bookingReady: !!(s?.booking_enabled && s.calendar_id),
    transferReady: !!s?.escalation_phone,
    summary: summarizeCalls(rows.filter((r) => Date.parse(r.created_at) >= Date.now() - 30 * 86400000)),
    allowance: computeAllowance(rows, now),
    recent: rows.slice(0, 50),
  };
}

export async function getRevenueDeskCall(tenantId: string, callId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(callId)) return null;
  const db = await createServerSupabaseClient();
  const call = await db.from("revenue_desk_calls").select("*").eq("tenant_id", tenantId).eq("id", callId).maybeSingle();
  if (call.error || !call.data) return null;
  const [bookings, events] = await Promise.all([
    db.from("revenue_desk_bookings").select("id, status, requested_start, requested_end, timezone, provider_event_id, failure_category, created_at, updated_at").eq("tenant_id", tenantId).eq("call_id", callId).order("created_at"),
    db.from("business_events").select("id, event_type, occurred_at, payload").eq("tenant_id", tenantId).eq("correlation_id", callId).order("occurred_at"),
  ]);
  return { call: call.data, bookings: bookings.data ?? [], events: events.data ?? [] };
}
