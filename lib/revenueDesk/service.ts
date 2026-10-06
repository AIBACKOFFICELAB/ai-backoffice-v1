import { createHash, randomUUID } from "crypto";
import { evaluateToolCall } from "@/lib/agents/permissions";
import type { Agent } from "@/lib/agents/types";
import type { EmitEventInput } from "@/lib/events/types";
import { bookingConfigProblem, durationFor, type RevenueDeskConfig } from "./config";
import { classifyUrgency, type UrgencyDecision } from "./urgency";
import { generateSlots, zonedToUtc } from "./slots";
import { bookAppointment, type BookingStore } from "./booking";
import { CalendarError, type CalendarProvider } from "./calendar/types";
import { REVENUE_DESK_TOOLS, type CaptureIntakeInput, type RevenueDeskToolName } from "./tools";
import { toCanonicalIntakePayload } from "./intake";

export type CallStatus = "in_progress" | "intake_captured" | "booked" | "escalated" | "completed" | "failed";

export type CallRow = {
  id: string;
  tenantId: string;
  providerCallId: string;
  callerPhone: string | null;
  leadId: string | null;
  status: CallStatus;
  priority: UrgencyDecision["priority"] | null;
  intake: (CaptureIntakeInput & { reasons?: string[] }) | null;
  escalationReason: string | null;
};

export type CallPatch = Partial<{
  status: CallStatus;
  leadId: string;
  priority: UrgencyDecision["priority"];
  urgencySignals: string[];
  serviceCategory: string | null;
  intake: Record<string, unknown>;
  escalationReason: string;
  escalationResult: "requested" | "transferred" | "transfer_failed" | "not_required";
  bookingOutcome: "confirmed" | "conflict" | "failed" | "not_attempted" | "unavailable";
  availabilityCheckedAt: string;
  endedAt: string;
  startedAt: string;
  durationSeconds: number;
  providerCostUsd: number;
  endedReason: string;
  failureCategory: string;
}>;

export type TenantResolution = { config: RevenueDeskConfig };

export interface RevenueDeskStore {
  /** Trusted identity: the provider phone-number id configured by the Founder. */
  resolveTenantByProviderNumber(providerPhoneNumberId: string): Promise<TenantResolution | null>;
  /** Idempotent on (tenant_id, provider, provider_call_id). */
  upsertCall(input: { tenantId: string; providerCallId: string; providerPhoneNumberId: string; callerPhone: string | null; calledPhone: string | null; startedAt: string | null }): Promise<{ call: CallRow; created: boolean }>;
  updateCall(tenantId: string, callId: string, patch: CallPatch): Promise<void>;
  getAgent(tenantId: string): Promise<Agent | null>;
  /** Canonical intake (source voice_receptionist, sourceRef = callId). Returns lead id. */
  createLead(tenantId: string, payload: Record<string, unknown>): Promise<string>;
  emit(input: EmitEventInput): Promise<void>;
}

export type RevenueDeskDeps = { store: RevenueDeskStore; bookings: BookingStore; calendar: CalendarProvider; now?: () => Date };

export type ToolResponse = Record<string, unknown> & { ok: boolean };

export const hashProviderId = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 24);

/**
 * Call lifecycle entry: resolve tenant from TRUSTED provider number identity,
 * then create/reuse the call row. Returns null when the tenant cannot be
 * resolved or Revenue Desk is disabled — the adapter then fails safe without
 * exposing any business identity.
 */
export async function startOrResumeCall(
  deps: RevenueDeskDeps,
  p: { providerCallId: string; providerPhoneNumberId: string | null; callerPhone: string | null; calledPhone: string | null; startedAt: string | null }
): Promise<{ config: RevenueDeskConfig; call: CallRow } | null> {
  if (!p.providerPhoneNumberId || !p.providerCallId) return null;
  const resolved = await deps.store.resolveTenantByProviderNumber(p.providerPhoneNumberId);
  if (!resolved || !resolved.config.enabled) return null;
  const { config } = resolved;
  const { call, created } = await deps.store.upsertCall({ tenantId: config.tenantId, providerCallId: p.providerCallId, providerPhoneNumberId: p.providerPhoneNumberId, callerPhone: p.callerPhone, calledPhone: p.calledPhone, startedAt: p.startedAt });
  if (created) {
    await safeEmit(deps, config.tenantId, "revenue_desk.call_started", call.id, `rd:${call.id}:started`, { callId: call.id, providerCallIdHash: hashProviderId(p.providerCallId) });
  }
  return { config, call };
}

/** Public, PII-free greeting/config the assistant may use. */
export function assistantContext(cfg: RevenueDeskConfig) {
  return {
    businessName: cfg.businessName,
    greeting: cfg.greeting ?? `Thanks for calling ${cfg.businessName}. How can we help today?`,
    serviceCategories: cfg.serviceCategories,
    faqs: cfg.faqs,
    bookingAvailable: bookingConfigProblem(cfg) === null,
  };
}

/**
 * Tool-execution audit (replaces the agent_runs/tool_calls trail runAgent()
 * would write): EVERY attempt — success, failure, refusal, invalid input,
 * unknown tool — emits one `revenue_desk.tool_attempted` business event with
 * tenant, call id (entity + correlation), agent id, tool name, outcome,
 * sanitized failure code and affected lead/booking ids. Never arguments,
 * transcript, model text or PII (enforced by the allowlist contract).
 * Keyed by the provider's toolCallId, so a redelivered tool call dedupes.
 */
export async function handleToolCall(
  deps: RevenueDeskDeps,
  ctx: { config: RevenueDeskConfig; call: CallRow },
  toolName: string,
  rawArgs: unknown,
  providerToolCallId?: string
): Promise<ToolResponse> {
  const audit: { agentId: string | null } = { agentId: null };
  const response = await executeTool(deps, ctx, toolName, rawArgs, audit);
  const outcome = response.ok ? "succeeded" : response.reason === "policy_denied" || response.reason === "agent_not_registered" || response.reason === "unknown_tool" ? "refused" : response.error === "INVALID_REQUEST" ? "invalid_input" : "failed";
  const failure = response.ok ? null : String(response.error ?? response.reason ?? "UNKNOWN").slice(0, 64);
  const known = toolName in REVENUE_DESK_TOOLS;
  await safeEmit(deps, ctx.config.tenantId, "revenue_desk.tool_attempted", ctx.call.id, `rd:${ctx.call.id}:tool:${providerToolCallId ?? randomUUID()}`, {
    callId: ctx.call.id,
    agentId: audit.agentId,
    toolName: known ? toolName : "unknown_tool",
    outcome,
    failureCategory: failure,
    leadId: ctx.call.leadId,
    bookingId: typeof response.bookingId === "string" ? response.bookingId : null,
  });
  return response;
}

async function executeTool(
  deps: RevenueDeskDeps,
  ctx: { config: RevenueDeskConfig; call: CallRow },
  toolName: string,
  rawArgs: unknown,
  audit: { agentId: string | null }
): Promise<ToolResponse> {
  const tool = REVENUE_DESK_TOOLS[toolName as RevenueDeskToolName];
  if (!tool) return escalate("unknown_tool");

  // Policy engine: same evaluation every agent tool call goes through.
  const agent = await deps.store.getAgent(ctx.config.tenantId);
  if (!agent || agent.agentType !== "csr_lead_recovery") return escalate("agent_not_registered");
  audit.agentId = agent.id;
  const decision = evaluateToolCall(agent, tool);
  if (decision.decision !== "allow") return escalate("policy_denied");

  const parsed = tool.validateInput(rawArgs ?? {});
  if (!parsed.ok) return { ok: false, error: "INVALID_REQUEST", details: parsed.errors.slice(0, 3) };

  try {
    switch (tool.name) {
      case "revenue_desk_capture_intake":
        return await captureIntake(deps, ctx, parsed.value as CaptureIntakeInput);
      case "revenue_desk_classify_urgency":
        return classify(ctx);
      case "revenue_desk_check_availability":
        return await checkAvailability(deps, ctx, (parsed.value as { preferredDate: string | null }).preferredDate);
      case "revenue_desk_book_appointment":
        return await book(deps, ctx, parsed.value as { slotStart: string; durationMinutes: number; callerConfirmed: boolean });
      case "revenue_desk_get_escalation_route":
        return await escalationRoute(deps, ctx, (parsed.value as { reason: string }).reason);
    }
  } catch (e) {
    console.error("[revenue-desk] tool failed", { tool: tool.name, callId: ctx.call.id, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    await deps.store.updateCall(ctx.config.tenantId, ctx.call.id, { failureCategory: "TOOL_FAILURE" }).catch(() => {});
    return escalate("tool_failure");
  }
  return escalate("unknown_tool");
}

function escalate(reason: string): ToolResponse {
  return { ok: false, requiredAction: "escalate", reason, instruction: "Do not promise anything. Offer to transfer the caller to the team." };
}

function decide(cfg: RevenueDeskConfig, intake: CaptureIntakeInput): UrgencyDecision {
  return classifyUrgency(cfg, { signals: intake.urgencySignals, serviceCategory: intake.serviceCategory, postalCode: intake.postalCode });
}

async function captureIntake(deps: RevenueDeskDeps, ctx: { config: RevenueDeskConfig; call: CallRow }, input: CaptureIntakeInput): Promise<ToolResponse> {
  const { config, call } = ctx;
  const decision = decide(config, input);
  let leadId: string;
  try {
    leadId = await deps.store.createLead(config.tenantId, toCanonicalIntakePayload(call.id, call.callerPhone, input, decision));
  } catch {
    // Truthful failure: nothing was saved; hand to a human with what we have.
    await deps.store.updateCall(config.tenantId, call.id, { failureCategory: "INTAKE_PERSIST_FAILED" });
    return { ok: false, error: "INTAKE_NOT_SAVED", requiredAction: "escalate", instruction: "Do not say the request was saved. Offer a transfer to the team." };
  }
  const nextStatus: CallStatus = call.status === "booked" || call.status === "escalated" ? call.status : "intake_captured";
  await deps.store.updateCall(config.tenantId, call.id, {
    leadId,
    status: nextStatus,
    priority: decision.priority,
    urgencySignals: decision.signals,
    serviceCategory: input.serviceCategory,
    intake: { ...input, reasons: decision.reasons },
  });
  ctx.call = { ...call, leadId, status: nextStatus, priority: decision.priority, intake: { ...input, reasons: decision.reasons } };
  await safeEmit(deps, config.tenantId, "revenue_desk.intake_captured", call.id, `rd:${call.id}:intake`, { callId: call.id, leadId, serviceCategory: input.serviceCategory });
  await safeEmit(deps, config.tenantId, "revenue_desk.urgency_classified", call.id, `rd:${call.id}:urgency:${decision.priority}`, { callId: call.id, priority: decision.priority, requiredAction: decision.requiredAction, reasons: decision.reasons, signals: decision.signals });
  return { ok: true, saved: true, priority: decision.priority, requiredAction: decision.requiredAction };
}

function classify(ctx: { config: RevenueDeskConfig; call: CallRow }): ToolResponse {
  if (!ctx.call.intake) return { ok: false, error: "INTAKE_REQUIRED", instruction: "Capture intake first." };
  const d = decide(ctx.config, ctx.call.intake);
  return { ok: true, priority: d.priority, requiredAction: d.requiredAction, reasons: d.reasons };
}

async function checkAvailability(deps: RevenueDeskDeps, ctx: { config: RevenueDeskConfig; call: CallRow }, preferredDate: string | null): Promise<ToolResponse> {
  const { config, call } = ctx;
  if (!call.intake) return { ok: false, error: "INTAKE_REQUIRED", instruction: "Capture intake first." };
  const d = decide(config, call.intake);
  if (d.requiredAction !== "offer_booking") return escalate("policy_requires_escalation");
  if (bookingConfigProblem(config)) return escalate("booking_not_configured");

  const now = deps.now?.() ?? new Date();
  let from = now;
  if (preferredDate) {
    const [y, m, dd] = preferredDate.split("-").map(Number);
    const local = zonedToUtc(y, m, dd, 0, 0, config.timezone);
    if (local.getTime() > now.getTime()) from = local;
  }
  const days = 5;
  const timeMin = from.toISOString();
  const timeMax = new Date(from.getTime() + days * 86400000).toISOString();
  const duration = durationFor(config, call.intake.serviceCategory ?? "");
  try {
    const busy = await deps.calendar.getBusy(config.calendarId!, timeMin, timeMax);
    const slots = generateSlots(config, { now: from.getTime() > now.getTime() ? new Date(from.getTime()) : now, durationMinutes: duration, busy, days, maxSlots: 3 }).filter((s) => Date.parse(s.start) > now.getTime());
    await deps.store.updateCall(config.tenantId, call.id, { availabilityCheckedAt: now.toISOString(), ...(slots.length === 0 ? { bookingOutcome: "unavailable" as const } : {}) });
    await safeEmit(deps, config.tenantId, "revenue_desk.availability_checked", call.id, `rd:${call.id}:availability:${now.getTime()}`, { callId: call.id, slotCount: slots.length });
    if (slots.length === 0) return { ok: true, slots: [], instruction: "No open times were found. Offer to have the team call back; do not invent a time." };
    return { ok: true, slots: slots.map((s) => ({ slotStart: s.start, end: s.end, timezone: s.timezone, durationMinutes: s.durationMinutes, local: localLabel(s.start, s.timezone) })) };
  } catch (e) {
    const cat = e instanceof CalendarError ? e.category : "CALENDAR_UNAVAILABLE";
    await deps.store.updateCall(config.tenantId, call.id, { failureCategory: cat, bookingOutcome: "unavailable" });
    await safeEmit(deps, config.tenantId, "revenue_desk.availability_checked", call.id, `rd:${call.id}:availability-failed:${now.getTime()}`, { callId: call.id, slotCount: 0, failureCategory: cat });
    return { ok: false, error: cat, requiredAction: "escalate", instruction: "The schedule could not be checked. Do not offer a time. Offer a transfer or a team callback." };
  }
}

async function book(deps: RevenueDeskDeps, ctx: { config: RevenueDeskConfig; call: CallRow }, input: { slotStart: string; durationMinutes: number; callerConfirmed: boolean }): Promise<ToolResponse> {
  const { config, call } = ctx;
  if (!call.intake || !call.leadId) return { ok: false, error: "INTAKE_REQUIRED", instruction: "Capture intake first." };
  const d = decide(config, call.intake);
  if (d.requiredAction !== "offer_booking") return escalate("policy_requires_escalation");
  // Duration is policy-owned; a model-supplied mismatch is refused.
  if (input.durationMinutes !== durationFor(config, call.intake.serviceCategory ?? "")) return { ok: false, error: "INVALID_REQUEST", instruction: "Use a slot exactly as returned by availability." };

  await safeEmit(deps, config.tenantId, "revenue_desk.booking_requested", call.id, `rd:${call.id}:book-req:${input.slotStart}`, { callId: call.id, durationMinutes: input.durationMinutes });
  const result = await bookAppointment(
    { store: deps.bookings, calendar: deps.calendar, now: deps.now },
    { cfg: config, callId: call.id, leadId: call.leadId, start: input.slotStart, durationMinutes: input.durationMinutes, callerConfirmed: input.callerConfirmed, summary: `AIBO booking — ${call.intake.serviceCategory ?? "Service"} (${call.intake.customerName})` }
  );
  if (result.confirmed) {
    await deps.store.updateCall(config.tenantId, call.id, { status: "booked", bookingOutcome: "confirmed" });
    ctx.call = { ...call, status: "booked" };
    await safeEmit(deps, config.tenantId, "revenue_desk.booking_confirmed", call.id, `rd:booking:${result.bookingId}:confirmed`, { callId: call.id, bookingId: result.bookingId, leadId: call.leadId, providerEventPresent: true, deduped: result.deduped });
    return { ok: true, booked: true, bookingId: result.bookingId, start: result.start, end: result.end, timezone: result.timezone, local: localLabel(result.start, result.timezone), instruction: "The calendar confirmed this appointment. You may tell the caller it is booked." };
  }
  const outcome = result.failure === "SLOT_UNAVAILABLE" ? "conflict" : "failed";
  await deps.store.updateCall(config.tenantId, call.id, { bookingOutcome: outcome, failureCategory: result.statusUnknown ? "BOOKING_STATUS_UNKNOWN" : result.failure });
  await safeEmit(deps, config.tenantId, "revenue_desk.booking_failed", call.id, `rd:${call.id}:book-fail:${input.slotStart}:${result.failure}`, { callId: call.id, bookingId: result.bookingId, failureCategory: result.failure });
  return {
    ok: false,
    booked: false,
    error: result.failure,
    instruction:
      result.failure === "SLOT_UNAVAILABLE"
        ? "That time was just taken. Do not say it is booked. Offer to check availability again."
        : "The appointment was NOT booked. Do not say it is booked. Offer a transfer or a team callback.",
  };
}

async function escalationRoute(deps: RevenueDeskDeps, ctx: { config: RevenueDeskConfig; call: CallRow }, reason: string): Promise<ToolResponse> {
  const { config, call } = ctx;
  const status: CallStatus = call.status === "booked" ? "booked" : "escalated";
  await deps.store.updateCall(config.tenantId, call.id, { status, escalationReason: reason, escalationResult: "requested" });
  ctx.call = { ...call, status, escalationReason: reason };
  await safeEmit(deps, config.tenantId, "revenue_desk.escalation_requested", call.id, `rd:${call.id}:escalation`, { callId: call.id, escalationReason: reason });
  if (!config.escalationPhone) {
    return { ok: true, transferAvailable: false, instruction: "No live transfer is configured. Tell the caller the team will call them back; do not promise a time." };
  }
  // The number itself is never returned to the model; the provider's
  // transfer-destination request is answered server-side from config.
  return { ok: true, transferAvailable: true, instruction: "Tell the caller you are transferring them to the team now, then use the transfer tool." };
}

/** Server-side answer to the provider's transfer-destination request. */
export async function transferDestination(deps: RevenueDeskDeps, ctx: { config: RevenueDeskConfig; call: CallRow }): Promise<string | null> {
  return ctx.config.escalationPhone;
}

export async function completeCall(
  deps: RevenueDeskDeps,
  ctx: { config: RevenueDeskConfig; call: CallRow },
  report: { endedAt: string | null; startedAt: string | null; durationSeconds: number | null; costUsd: number | null; endedReason: string | null; transferred: boolean | null }
) {
  const { config, call } = ctx;
  const failed = !!report.endedReason && /error|failed|fault/i.test(report.endedReason);
  const status: CallStatus = call.status === "booked" || call.status === "escalated" ? call.status : failed ? "failed" : "completed";
  const patch: CallPatch = { status, endedReason: (report.endedReason ?? "unknown").slice(0, 80) };
  if (report.endedAt) patch.endedAt = report.endedAt;
  if (report.startedAt) patch.startedAt = report.startedAt;
  if (report.durationSeconds != null) patch.durationSeconds = Math.round(report.durationSeconds);
  if (report.costUsd != null) patch.providerCostUsd = report.costUsd;
  if (call.status === "escalated" && report.transferred != null) patch.escalationResult = report.transferred ? "transferred" : "transfer_failed";
  if (failed) patch.failureCategory = "PROVIDER_CALL_ERROR";
  await deps.store.updateCall(config.tenantId, call.id, patch);
  await safeEmit(deps, config.tenantId, failed ? "revenue_desk.call_failed" : "revenue_desk.call_completed", call.id, `rd:${call.id}:ended`, {
    callId: call.id,
    status,
    endedReason: patch.endedReason ?? null,
    durationSeconds: patch.durationSeconds ?? null,
    costUsd: report.costUsd ?? null,
  });
}

async function safeEmit(deps: RevenueDeskDeps, tenantId: string, eventType: string, callId: string, key: string, payload: Record<string, unknown>) {
  try {
    await deps.store.emit({ tenantId, eventType, actorType: "agent", entityType: "revenue_desk_call", entityId: callId, correlationId: callId, idempotencyKey: key, payload });
  } catch (e) {
    console.error("[revenue-desk] event emit failed", { eventType, callId, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
  }
}

function localLabel(iso: string, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
