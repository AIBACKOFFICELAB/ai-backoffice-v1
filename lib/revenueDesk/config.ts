/**
 * Revenue Desk tenant configuration — parsed from revenue_desk_settings.
 * Pure validation: an invalid config is a CONFIGURATION_ERROR and fails
 * toward human escalation, never toward guessing.
 */

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "HH:MM" local open/close per weekday; missing day = closed. */
export type OperatingHours = Partial<Record<Weekday, { open: string; close: string }>>;

export type UrgencyRules = {
  /** Signals that force a human escalation (and forbid autonomous booking). */
  escalate: string[];
  /** Signals classified `urgent` (booking allowed only if `allowUrgentBooking`). */
  urgent: string[];
  priority: string[];
  allowUrgentBooking: boolean;
};

export type RevenueDeskConfig = {
  tenantId: string;
  enabled: boolean;
  businessName: string;
  greeting: string | null;
  timezone: string;
  operatingHours: OperatingHours;
  serviceCategories: string[];
  /** Allowed postal codes; empty = area not restricted. */
  serviceAreaZips: string[];
  urgencyRules: UrgencyRules;
  bookingEnabled: boolean;
  defaultDurationMinutes: number;
  serviceDurations: Record<string, number>;
  bufferMinutes: number;
  calendarProvider: "google";
  calendarId: string | null;
  escalationPhone: string | null;
  faqs: Array<{ q: string; a: string }>;
  /** Founder-configured SAVED Vapi assistant. Its server URL + credentialId
   * (and its saved tools') carry the HMAC credential; a transient assistant
   * or server override would be sent WITHOUT it. */
  vapiAssistantId: string | null;
};

export const DEFAULT_URGENCY_RULES: UrgencyRules = {
  escalate: [
    "suspected_gas",
    "electrical_hazard",
    "caller_requests_human",
    "complaint",
    "pricing_negotiation",
    "unsupported_service",
    "ambiguous_service",
    "caller_says_emergency",
    "sewage_backup",
    "active_flooding",
  ],
  urgent: ["active_major_leak", "no_water"],
  priority: [],
  allowUrgentBooking: false,
};

export class ConfigError extends Error {}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
}

/** Maps a DB row (+ tenant name) into a validated config. Throws ConfigError. */
export function parseRevenueDeskConfig(row: Record<string, any>, businessName: string): RevenueDeskConfig {
  if (!row?.tenant_id) throw new ConfigError("missing tenant");
  const timezone = String(row.timezone ?? "");
  if (!isValidTimeZone(timezone)) throw new ConfigError("invalid timezone");

  const hours: OperatingHours = {};
  for (const [day, v] of Object.entries(row.operating_hours ?? {})) {
    if (!WEEKDAYS.includes(day as Weekday)) throw new ConfigError(`invalid weekday ${day}`);
    const h = v as { open?: string; close?: string };
    if (!h || !HHMM.test(h.open ?? "") || !HHMM.test(h.close ?? "") || h.open! >= h.close!) throw new ConfigError(`invalid hours for ${day}`);
    hours[day as Weekday] = { open: h.open!, close: h.close! };
  }

  const ur = row.urgency_rules ?? {};
  const hasCustomRules = ur && typeof ur === "object" && Object.keys(ur).length > 0;
  const urgencyRules: UrgencyRules = hasCustomRules
    ? {
        // Safety signals always escalate even if a tenant config forgets them.
        escalate: Array.from(new Set([...strArray(ur.escalate), "suspected_gas", "electrical_hazard", "caller_requests_human"])),
        urgent: strArray(ur.urgent),
        priority: strArray(ur.priority),
        allowUrgentBooking: ur.allowUrgentBooking === true,
      }
    : DEFAULT_URGENCY_RULES;

  const durations: Record<string, number> = {};
  for (const [k, v] of Object.entries(row.service_durations ?? {})) {
    if (typeof v === "number" && v >= 15 && v <= 480) durations[k] = v;
  }

  const escalationPhone = row.escalation_phone ? String(row.escalation_phone) : null;
  if (escalationPhone && !E164.test(escalationPhone)) throw new ConfigError("escalation phone must be E.164");

  const vapiAssistantId = row.vapi_assistant_id ? String(row.vapi_assistant_id).trim() : null;
  if (vapiAssistantId && !UUID.test(vapiAssistantId)) throw new ConfigError("vapi assistant id must be a Vapi assistant UUID");

  const zips = strArray(row.service_area?.zips);
  const faqs = Array.isArray(row.faqs)
    ? row.faqs.filter((f: any) => typeof f?.q === "string" && typeof f?.a === "string").map((f: any) => ({ q: f.q, a: f.a }))
    : [];

  return {
    tenantId: row.tenant_id,
    enabled: row.enabled === true,
    businessName,
    greeting: row.greeting ?? null,
    timezone,
    operatingHours: hours,
    serviceCategories: strArray(row.service_categories),
    serviceAreaZips: zips,
    urgencyRules,
    bookingEnabled: row.booking_enabled === true,
    defaultDurationMinutes: Number(row.default_appointment_duration_minutes ?? 60),
    serviceDurations: durations,
    bufferMinutes: Number(row.buffer_minutes ?? 0),
    calendarProvider: "google",
    calendarId: row.calendar_id ? String(row.calendar_id) : null,
    escalationPhone,
    faqs,
    vapiAssistantId,
  };
}

/** Booking needs every one of these; otherwise escalate as CONFIGURATION_ERROR. */
export function bookingConfigProblem(cfg: RevenueDeskConfig): string | null {
  if (!cfg.enabled) return "revenue_desk_disabled";
  if (!cfg.bookingEnabled) return "booking_disabled";
  if (!cfg.calendarId) return "calendar_not_configured";
  if (Object.keys(cfg.operatingHours).length === 0) return "operating_hours_not_configured";
  return null;
}

export function durationFor(cfg: RevenueDeskConfig, serviceCategory: string): number {
  return cfg.serviceDurations[serviceCategory] ?? cfg.defaultDurationMinutes;
}
