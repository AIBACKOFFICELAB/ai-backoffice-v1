import { randomUUID } from "node:crypto";
import type { LeadInsert, PlumbingLead } from "@/data/leadModel";
import type { EmitEventInput } from "@/lib/events/types";
import { IntakeError, validateIntake } from "./validation";

export type IntakeSource = "website_form" | "manual";
export type IntakeTenant = { id: string; name: string; email: string | null };
export interface IntakeDeps {
  persist(lead: LeadInsert, tenantId: string): Promise<{ lead: PlumbingLead; deduped: boolean }>;
  emit(input: EmitEventInput): Promise<{ deduped: boolean }>;
  notify(tenant: IntakeTenant, lead: PlumbingLead): Promise<void>;
}
/** Server domain boundary. Adapters supply a SERVER-resolved tenant, never body tenant_id.
 * Lead uniqueness is DB-enforced. Success means both lead and governed event exist.
 * Event failure preserves the lead and returns a retryable error; replay heals the gap.
 * There are no lifecycle, agent, approval, model or outcome calls here.
 */
export async function createCanonicalLeadFromIntake(raw: unknown, tenant: IntakeTenant, source: IntakeSource, actorUserId: string | null, deps: IntakeDeps) {
  const input = validateIntake(raw);
  if (!tenant.id || (source !== "website_form" && source !== "manual") || (source === "manual" && !actorUserId)) throw new IntakeError("FORBIDDEN", "Unable to accept this request.", 403);
  const { sourceRef, ...fields } = input;
  const receivedAt = new Date().toISOString();
  const result = await deps.persist({
    ...fields, id: randomUUID(), date: receivedAt, source, sourceRef,
    intakeSchemaVersion: 1, receivedAt, status: "New", estimateAmount: 0,
    photosUploaded: "No", followUpDate: "", reviewRequestStatus: "Not Ready", internalNotes: "",
  }, tenant.id);
  const lead = result.lead;
  let event: { deduped: boolean };
  try {
    event = await deps.emit({
      tenantId: tenant.id, eventType: "lead.created", actorType: source === "manual" ? "user" : "integration",
      actorId: actorUserId, entityType: "lead", entityId: lead.id,
      idempotencyKey: `lead.created:${lead.id}`, occurredAt: lead.receivedAt,
      payload: { leadId: lead.id, source: lead.source, serviceType: lead.serviceType, emergency: lead.emergency, receivedAt: lead.receivedAt },
    });
  } catch {
    console.error("[intake] event persistence failed; retry with the same submission identity", { leadId: lead.id });
    throw new IntakeError("RETRY_SUBMISSION", "Your request may already be saved. Please retry this same submission to finish confirmation.", 503);
  }
  // The unique event winner attempts the notification, including after event-repair retries.
  // Secondary, best-effort delivery; neither failure nor missing configuration removes a lead.
  if (!event.deduped) {
    try { await deps.notify(tenant, lead); }
    catch { console.error("[intake] owner notification failed", { leadId: lead.id }); }
  }
  return result;
}
