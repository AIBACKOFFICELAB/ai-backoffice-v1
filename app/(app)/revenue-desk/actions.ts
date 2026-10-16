"use server";

import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import { getTenantContext } from "@/lib/tenant";
import { createBookingStore, createRevenueDeskStore, getBookingForReconciliation } from "@/lib/revenueDesk/store.server";
import { GoogleCalendarProvider } from "@/lib/revenueDesk/calendar/google";
import { reconcileBooking } from "@/lib/revenueDesk/booking";

/** One owner-authorized evidence check. No insert, delete, routing, or sends.
 * DB lease throttles retries per booking; unresolved rows stay in the queue.
 */
export async function checkBookingEvidence(form: FormData): Promise<void> {
  const tenant = await getTenantContext();
  const id = form.get("bookingId");
  if (!tenant || tenant.role !== "owner" || typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return;
  try {
    const booking = await getBookingForReconciliation(tenant.tenantId, id);
    if (!booking || booking.status !== "pending") return;
    const audit = createRevenueDeskStore();
    const key = `rd:${id}:reconcile:${randomUUID()}`;
    const evidence = { tenantId: tenant.tenantId, actorType: "user" as const, actorId: tenant.userId,
      entityType: "revenue_desk_call", entityId: booking.callId, correlationId: booking.callId };
    // Refuse privileged reconciliation if its intent cannot be audited.
    await audit.emit({ ...evidence, eventType: "revenue_desk.booking_reconciliation_requested", idempotencyKey: key,
      payload: { callId: booking.callId, bookingId: booking.id } });
    const result = await reconcileBooking({ store: createBookingStore(), calendar: new GoogleCalendarProvider() }, booking);
    await audit.emit({ ...evidence, eventType: "revenue_desk.booking_reconciled", idempotencyKey: `${key}:result`,
      payload: { callId: booking.callId, bookingId: booking.id, outcome: result.confirmed ? "confirmed" : "unresolved" } });
    revalidatePath(`/revenue-desk/${booking.callId}`);
    revalidatePath("/revenue-desk");
  } catch {
    // No result is asserted; durable pending evidence remains owner-visible.
    console.error("[revenue-desk] reconciliation unavailable");
  }
}
