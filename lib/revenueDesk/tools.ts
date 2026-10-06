import type { ToolDefinition, ToolValidation } from "@/lib/agents/toolRegistry";
import { conservativeAuditFallback } from "@/lib/agents/toolRegistry";
import type { Agent, CreateAgentInput } from "@/lib/agents/types";
import { URGENCY_SIGNALS } from "./urgency";

/**
 * Revenue Desk tool contract. These definitions are the SECURITY AUTHORITY
 * for the receptionist (permission, effect class, autonomy floor, input
 * schema), evaluated per call by lib/agents/permissions.ts::evaluateToolCall
 * — the same policy engine every agent uses. They live in their OWN registry
 * (REVENUE_DESK_TOOLS), never DEFAULT_TOOL_REGISTRY, so no other agent can be
 * granted them. Execution is dispatched by lib/revenueDesk/service.ts with a
 * SERVER-resolved tenant; model arguments are untrusted input and may never
 * carry tenant identity, URLs, or phone numbers for transfer.
 *
 * None of these tools sends SMS/email or places a call.
 */

type Input = Record<string, unknown>;
const isRecord = (v: unknown): v is Input => typeof v === "object" && v !== null && !Array.isArray(v);

function allowKeys(v: Input, allowed: string[]): string[] {
  return Object.keys(v).filter((k) => !allowed.includes(k));
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) return null;
  return t;
}

export type CaptureIntakeInput = {
  customerName: string;
  callbackPhone: string | null;
  serviceAddress: string | null;
  postalCode: string | null;
  serviceCategory: string | null;
  jobDescription: string;
  urgencySignals: string[];
  preferredTiming: string | null;
  notes: string | null;
};
export type CheckAvailabilityInput = { preferredDate: string | null };
export type BookInput = { slotStart: string; durationMinutes: number; callerConfirmed: boolean };

const notExecutable = async () => {
  throw new Error("Revenue Desk tools are dispatched by lib/revenueDesk/service.ts only");
};

function bounded<T>(name: string, allowed: string[], parse: (v: Input) => ToolValidation<T>) {
  return (input: unknown): ToolValidation<T> => {
    if (!isRecord(input)) return { ok: false, errors: [`${name}: input must be an object`] };
    const extra = allowKeys(input, allowed);
    // Explicitly rejects tenantId / transfer numbers / URLs a model might try to inject.
    if (extra.length) return { ok: false, errors: [`${name}: unexpected field(s): ${extra.join(", ")}`] };
    return parse(input);
  };
}

const common = { version: 1, requiredReadScopes: [] as string[], execute: notExecutable };

export const captureIntakeTool: ToolDefinition<CaptureIntakeInput> = {
  ...common,
  name: "revenue_desk_capture_intake",
  intrinsicPermission: "WRITE",
  effectClass: "internal_write",
  sideEffectClass: "internal_only",
  requiredWriteScopes: ["leads", "revenue_desk_calls"],
  minimumAutonomyTier: "AUTO_EXECUTE_AND_LOG",
  idempotent: true,
  validateInput: bounded("capture_intake", ["customerName", "callbackPhone", "serviceAddress", "postalCode", "serviceCategory", "jobDescription", "urgencySignals", "preferredTiming", "notes"], (v) => {
    const customerName = str(v.customerName, 120);
    const jobDescription = str(v.jobDescription, 2000);
    if (!customerName || !jobDescription) return { ok: false, errors: ["customerName and jobDescription are required"] };
    const phone = v.callbackPhone == null ? null : str(v.callbackPhone, 40);
    if (phone && !/^\+?[()0-9 .-]{7,20}$/.test(phone)) return { ok: false, errors: ["invalid callbackPhone"] };
    const zip = v.postalCode == null ? null : str(v.postalCode, 10);
    if (zip && !/^\d{5}(-\d{4})?$/.test(zip)) return { ok: false, errors: ["invalid postalCode"] };
    const signals = Array.isArray(v.urgencySignals) ? v.urgencySignals.filter((s) => typeof s === "string").slice(0, 12) : [];
    return {
      ok: true,
      value: {
        customerName,
        callbackPhone: phone,
        serviceAddress: v.serviceAddress == null ? null : str(v.serviceAddress, 300),
        postalCode: zip,
        serviceCategory: v.serviceCategory == null ? null : str(v.serviceCategory, 60),
        jobDescription,
        urgencySignals: signals as string[],
        preferredTiming: v.preferredTiming == null ? null : str(v.preferredTiming, 200),
        notes: v.notes == null ? null : str(v.notes, 500),
      },
    };
  }),
  summarizeInputForAudit(input) {
    if (!isRecord(input)) return conservativeAuditFallback(input);
    return { serviceCategory: typeof input.serviceCategory === "string" ? input.serviceCategory : null, signalCount: Array.isArray(input.urgencySignals) ? input.urgencySignals.length : 0 };
  },
};

export const classifyUrgencyTool: ToolDefinition<Input> = {
  ...common,
  name: "revenue_desk_classify_urgency",
  intrinsicPermission: "READ",
  effectClass: "read",
  sideEffectClass: "none",
  requiredWriteScopes: [],
  minimumAutonomyTier: "AUTO_EXECUTE",
  idempotent: true,
  // Takes NO model input: classification is recomputed from stored intake.
  validateInput: bounded("classify_urgency", [], () => ({ ok: true, value: {} })),
};

export const checkAvailabilityTool: ToolDefinition<CheckAvailabilityInput> = {
  ...common,
  name: "revenue_desk_check_availability",
  intrinsicPermission: "READ",
  effectClass: "read",
  sideEffectClass: "none",
  requiredWriteScopes: [],
  requiredReadScopes: ["calendar_freebusy"],
  minimumAutonomyTier: "AUTO_EXECUTE_AND_LOG",
  idempotent: true,
  validateInput: bounded("check_availability", ["preferredDate"], (v) => {
    const d = v.preferredDate == null ? null : str(v.preferredDate, 10);
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, errors: ["preferredDate must be YYYY-MM-DD"] };
    return { ok: true, value: { preferredDate: d } };
  }),
};

export const bookAppointmentTool: ToolDefinition<BookInput> = {
  ...common,
  name: "revenue_desk_book_appointment",
  // A calendar write on the business's own scheduling calendar. Never
  // customer-facing: events are created with sendUpdates="none".
  intrinsicPermission: "EXECUTE",
  effectClass: "internal_write",
  sideEffectClass: "internal_only",
  requiredWriteScopes: ["revenue_desk_bookings", "calendar_events"],
  minimumAutonomyTier: "AUTO_EXECUTE_AND_LOG",
  idempotent: true,
  validateInput: bounded("book_appointment", ["slotStart", "durationMinutes", "callerConfirmed"], (v) => {
    const s = str(v.slotStart, 40);
    if (!s || !Number.isFinite(Date.parse(s))) return { ok: false, errors: ["slotStart must be an ISO timestamp from check_availability"] };
    const dur = Number(v.durationMinutes);
    if (!Number.isInteger(dur) || dur < 15 || dur > 480) return { ok: false, errors: ["invalid durationMinutes"] };
    if (v.callerConfirmed !== true) return { ok: false, errors: ["caller must explicitly confirm the slot before booking"] };
    return { ok: true, value: { slotStart: s, durationMinutes: dur, callerConfirmed: true } };
  }),
};

export const escalationRouteTool: ToolDefinition<Input> = {
  ...common,
  name: "revenue_desk_get_escalation_route",
  intrinsicPermission: "READ",
  effectClass: "read",
  sideEffectClass: "none",
  requiredWriteScopes: [],
  minimumAutonomyTier: "AUTO_EXECUTE",
  idempotent: true,
  // No destination argument exists: the route always comes from tenant config.
  validateInput: bounded("get_escalation_route", ["reason"], (v) => {
    const reason = v.reason == null ? "unspecified" : str(v.reason, 40);
    if (!reason || !/^[a-z_]+$/.test(reason)) return { ok: false, errors: ["reason must be a snake_case code"] };
    return { ok: true, value: { reason } };
  }),
};

export const REVENUE_DESK_TOOLS = {
  [captureIntakeTool.name]: captureIntakeTool,
  [classifyUrgencyTool.name]: classifyUrgencyTool,
  [checkAvailabilityTool.name]: checkAvailabilityTool,
  [bookAppointmentTool.name]: bookAppointmentTool,
  [escalationRouteTool.name]: escalationRouteTool,
} as const;
export type RevenueDeskToolName = keyof typeof REVENUE_DESK_TOOLS;

/** Registration shape for the dedicated receptionist agent. Created INACTIVE;
 * activation is an explicit, separate Founder-assisted step. */
export function revenueDeskAgentDefinition(tenantId: string): CreateAgentInput {
  return {
    tenantId,
    agentType: "csr_lead_recovery",
    name: "Revenue Desk Receptionist",
    purpose:
      "Receive inbound service-business calls, capture structured intake, classify priority through deterministic AIBO policy, read authorized calendar availability, create eligible caller-confirmed appointments, and safely escalate unsupported/unsafe/uncertain calls. Cannot message customers, place calls, negotiate prices, or take payment.",
    status: "inactive",
    allowedTools: Object.keys(REVENUE_DESK_TOOLS),
    readScopes: ["revenue_desk_settings", "calendar_freebusy"],
    writeScopes: ["leads", "revenue_desk_calls", "revenue_desk_bookings", "calendar_events"],
    approvalPolicy: {
      revenue_desk_capture_intake: "AUTO_EXECUTE_AND_LOG",
      revenue_desk_classify_urgency: "AUTO_EXECUTE",
      revenue_desk_check_availability: "AUTO_EXECUTE_AND_LOG",
      revenue_desk_book_appointment: "AUTO_EXECUTE_AND_LOG",
      revenue_desk_get_escalation_route: "AUTO_EXECUTE",
    },
    modelPolicy: {},
    systemInstructions: null,
  };
}

export type { Agent };
