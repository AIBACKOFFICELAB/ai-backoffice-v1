import { intakeOptions } from "@/lib/leads/intake/validation";
import type { CaptureIntakeInput } from "./tools";
import type { UrgencyDecision } from "./urgency";

/**
 * Maps voice intake onto the EXISTING canonical intake contract
 * (lib/leads/intake/validation.ts) using safe server-side defaults for
 * historical fields the caller is never interrogated about. The Revenue
 * Desk call UUID is the durable submission identity (sourceRef), so the DB
 * unique index (tenant_id, source, source_ref) dedupes provider retries.
 */
export function toCanonicalIntakePayload(callId: string, callerPhoneFromProvider: string | null, input: CaptureIntakeInput, decision: UrgencyDecision) {
  const serviceTypes = intakeOptions.serviceType as readonly string[];
  const serviceType = input.serviceCategory && serviceTypes.includes(input.serviceCategory) ? input.serviceCategory : "Other";
  const emergencyish = decision.signals.some((s) => ["caller_says_emergency", "active_flooding", "sewage_backup", "suspected_gas", "electrical_hazard", "active_major_leak"].includes(s));
  const urgency = emergencyish ? "Emergency" : decision.priority === "urgent" ? "Same Day" : decision.priority === "priority" ? "This Week" : "Flexible";
  const phone = (input.callbackPhone ?? callerPhoneFromProvider ?? "").replace(/[(). -]/g, "");
  return {
    sourceRef: callId,
    customerName: input.customerName,
    phone,
    email: "",
    serviceAddress: input.serviceAddress ?? "Not provided on call",
    propertyType: "Other",
    serviceType,
    emergency: emergencyish ? "Yes" : "No",
    urgency,
    jobDescription: input.jobDescription,
    preferredAppointmentTime: input.preferredTiming ?? "",
    customerRole: "Other",
    leadSource: "Other",
    customerNotes: input.notes ?? "",
  };
}
