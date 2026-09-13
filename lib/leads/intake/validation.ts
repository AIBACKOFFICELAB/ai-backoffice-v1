import type { PlumbingLead } from "@/data/leadModel";

export const intakeOptions = {
  propertyType: ["Single Family Home", "Condo / Apartment", "Commercial Property", "Property Management Unit", "Other"],
  serviceType: ["Water Heater", "Toilet Repair", "Leak Detection", "PRV Replacement", "Drain Cleaning", "Shower Valve", "Faucet / Cartridge", "Garbage Disposal", "Emergency Plumbing", "Property Management Work Order", "Other"],
  emergency: ["Yes", "No"],
  urgency: ["Emergency", "Same Day", "This Week", "Flexible"],
  customerRole: ["Owner", "Tenant", "Property Manager", "Contractor / GC", "Other"],
  leadSource: ["Google", "Website", "Referral", "Repeat Customer", "Property Manager", "Facebook", "Instagram", "Yelp", "Other"],
} as const satisfies { [K in "propertyType" | "serviceType" | "emergency" | "urgency" | "customerRole" | "leadSource"]: readonly PlumbingLead[K][] };

export const textFields = {
  customerName: { label: "Name", max: 120, required: true, autoComplete: "name" },
  phone: { label: "Phone", max: 40, required: true, autoComplete: "tel" },
  email: { label: "Email (optional)", max: 254, required: false, autoComplete: "email" },
  serviceAddress: { label: "Service address", max: 300, required: true, autoComplete: "street-address" },
  jobDescription: { label: "Describe the job", max: 4000, required: true, autoComplete: "off" },
  preferredAppointmentTime: { label: "Preferred appointment (optional)", max: 200, required: false, autoComplete: "off" },
  customerNotes: { label: "Additional notes (optional)", max: 2000, required: false, autoComplete: "off" },
} as const;
export type IntakePayload = Pick<PlumbingLead, keyof typeof textFields | keyof typeof intakeOptions> & { sourceRef: string };
export class IntakeError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateIntake(raw: unknown): IntakePayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new IntakeError("INVALID_INPUT", "Provide a service request.");
  const value = raw as Record<string, unknown>;
  const keys = new Set([...Object.keys(textFields), ...Object.keys(intakeOptions), "sourceRef", "website"]);
  if (Object.keys(value).some(key => !keys.has(key))) throw new IntakeError("INVALID_INPUT", "Unexpected request field.");
  if (typeof value.sourceRef !== "string" || !UUID.test(value.sourceRef)) throw new IntakeError("INVALID_INPUT", "A valid submission identity is required.");
  if (value.website !== undefined && value.website !== "") throw new IntakeError("INVALID_INPUT", "Unable to accept this request.");
  const result: Record<string, string> = { sourceRef: value.sourceRef.toLowerCase() };
  for (const [key, spec] of Object.entries(textFields)) {
    const input = value[key] ?? (spec.required ? null : "");
    if (typeof input !== "string" || input.length > spec.max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) throw new IntakeError("INVALID_INPUT", `Check ${spec.label.toLowerCase()}.`);
    result[key] = input.trim();
    if (spec.required && !result[key]) throw new IntakeError("INVALID_INPUT", `${spec.label} is required.`);
  }
  for (const [key, allowed] of Object.entries(intakeOptions)) {
    if (typeof value[key] !== "string" || !(allowed as readonly string[]).includes(value[key] as string)) throw new IntakeError("INVALID_INPUT", `Choose a valid ${key}.`);
    result[key] = value[key] as string;
  }
  if (!/^\+?[()0-9 .-]+$/.test(result.phone) || result.phone.replace(/\D/g, "").length < 7 || result.phone.replace(/\D/g, "").length > 15) throw new IntakeError("INVALID_INPUT", "Enter a valid phone number.");
  result.phone = result.phone.replace(/[(). -]/g, "");
  if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw new IntakeError("INVALID_INPUT", "Enter a valid email address.");
  return result as IntakePayload;
}
export function validPublicSlug(slug: string): boolean {
  return slug.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}
