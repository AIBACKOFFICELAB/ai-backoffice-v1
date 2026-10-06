import type { RevenueDeskConfig } from "./config";

/** Small bounded taxonomy. The voice model may REPORT these; policy decides. */
export const URGENCY_SIGNALS = [
  "caller_says_emergency",
  "active_flooding",
  "active_major_leak",
  "sewage_backup",
  "no_water",
  "suspected_gas",
  "electrical_hazard",
  "unsupported_service",
  "caller_requests_human",
  "complaint",
  "pricing_negotiation",
  "ambiguous_service",
] as const;
export type UrgencySignal = (typeof URGENCY_SIGNALS)[number];

export type Priority = "routine" | "priority" | "urgent" | "human_escalation_required";
export type RequiredAction = "offer_booking" | "escalate";

export type UrgencyDecision = {
  priority: Priority;
  requiredAction: RequiredAction;
  /** Machine reason codes only — never free text. */
  reasons: string[];
  signals: UrgencySignal[];
};

export function normalizeSignals(raw: unknown): { signals: UrgencySignal[]; unknown: number } {
  const list = Array.isArray(raw) ? raw : [];
  const signals = new Set<UrgencySignal>();
  let unknown = 0;
  for (const s of list) {
    if (typeof s === "string" && (URGENCY_SIGNALS as readonly string[]).includes(s)) signals.add(s as UrgencySignal);
    else unknown++;
  }
  return { signals: Array.from(signals), unknown };
}

/**
 * Deterministic server-side urgency policy. Same inputs -> same output.
 * Ambiguity fails toward a human: unknown signal values, an unsupported or
 * unconfigured service category, or an out-of-area address escalate.
 */
export function classifyUrgency(
  cfg: RevenueDeskConfig,
  input: { signals: unknown; serviceCategory: string | null; postalCode: string | null }
): UrgencyDecision {
  const { signals, unknown } = normalizeSignals(input.signals);
  const reasons: string[] = [];
  const set = new Set<string>(signals);

  if (unknown > 0) reasons.push("unrecognized_signal");
  if (!input.serviceCategory || !cfg.serviceCategories.includes(input.serviceCategory)) {
    set.add("unsupported_service");
    reasons.push("service_not_supported");
  }
  if (cfg.serviceAreaZips.length > 0) {
    const zip = (input.postalCode ?? "").trim().slice(0, 5);
    if (!zip || !cfg.serviceAreaZips.includes(zip)) reasons.push("outside_service_area");
  }

  const escalating = Array.from(set).filter((s) => cfg.urgencyRules.escalate.includes(s));
  reasons.push(...escalating.map((s) => `signal:${s}`));

  if (reasons.length > 0) {
    return { priority: "human_escalation_required", requiredAction: "escalate", reasons: dedupe(reasons), signals };
  }
  if (signals.some((s) => cfg.urgencyRules.urgent.includes(s))) {
    const allowed = cfg.urgencyRules.allowUrgentBooking;
    return {
      priority: "urgent",
      requiredAction: allowed ? "offer_booking" : "escalate",
      reasons: allowed ? ["urgent_booking_allowed"] : ["urgent_requires_human"],
      signals,
    };
  }
  if (signals.some((s) => cfg.urgencyRules.priority.includes(s))) {
    return { priority: "priority", requiredAction: "offer_booking", reasons: ["priority_signal"], signals };
  }
  return { priority: "routine", requiredAction: "offer_booking", reasons: ["routine"], signals };
}

function dedupe(a: string[]) {
  return Array.from(new Set(a));
}
