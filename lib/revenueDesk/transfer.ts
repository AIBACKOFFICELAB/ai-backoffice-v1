export type TransferOutcome = "requested" | "initiated" | "transferred" | "transfer_failed" | "unknown" | "not_required";

/** Vapi documented call-ended reasons. Forwarding confirms provider handoff,
 * not a person answering. Unknown/new reasons never become success by regex.
 * https://docs.vapi.ai/calls/call-ended-reason
 */
export function transferOutcome(reason: string | null): TransferOutcome {
  switch (reason) {
    case "assistant-forwarded-call": return "transferred";
    case "call.in-progress.error-transfer-failed": return "transfer_failed";
    case "customer-ended-call-during-transfer": return "unknown";
    default: return "unknown";
  }
}

export const transferLabel: Record<string, string> = {
  requested: "Transfer requested", initiated: "Transfer initiated",
  transferred: "Provider forwarding confirmed; human answer unverified",
  transfer_failed: "Transfer failed", unknown: "Transfer outcome unknown", not_required: "Not required",
};

/** Durable observations can include contradictions; none prove human answer. */
export const transferEvidenceLabel: Record<string, string> = {
  requested: "Transfer requested", initiated: "Transfer initiated",
  transferred: "Provider reported forwarding", transfer_failed: "Provider reported transfer failure",
  interrupted: "Caller disconnected during transfer",
  unverified_transferred: "Historical forwarding assertion is unverified",
  unverified_transfer_failed: "Historical transfer failure is unverified",
};
