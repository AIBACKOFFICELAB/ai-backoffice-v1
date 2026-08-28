import { BusinessEvent, EmitEventInput } from "./types";
import { BusinessEventStore, SupabaseBusinessEventStore } from "./store";
import { withTelemetryDeadline, sanitizeTelemetryError, TELEMETRY_DEADLINE_MS } from "@/lib/telemetry/deadline";
import { getEventContract } from "./contracts";

const defaultStore = new SupabaseBusinessEventStore();

/**
 * Emit a business event. Idempotent when `idempotencyKey` is provided: a
 * second emission with the same (tenantId, idempotencyKey) pair returns the
 * original event rather than creating a duplicate — the guarantee is the
 * database's unique index (migration 009), the store's pre-check is only a
 * fast path to avoid needless round-trips.
 *
 * This is the ONLY supported way to write to business_events. Callers pass
 * a store for testing; production code should rely on the default.
 */
export async function emitEvent(
  input: EmitEventInput,
  store: BusinessEventStore = defaultStore
): Promise<{ event: BusinessEvent; deduped: boolean }> {
  if (!input.tenantId) throw new Error("emitEvent requires tenantId");
  if (!input.eventType) throw new Error("emitEvent requires eventType");

  // P0.9 Slice C (finding M-04): enforce the registered event contract, if
  // one exists for this eventType, on the governed path. Unregistered
  // event types are not rejected — the taxonomy is deliberately not a hard
  // enum (see KNOWN_EVENT_TYPES) — only a REGISTERED contract's own rules
  // are enforced. See lib/events/contracts.ts.
  const contract = getEventContract(input.eventType);
  if (contract) {
    const validation = contract.validatePayload(input.payload ?? {});
    if (!validation.ok) {
      throw new Error(`emitEvent: payload for '${input.eventType}' violates its registered contract: ${validation.errors.join("; ")}`);
    }
  }

  return store.insert(input);
}

/**
 * Compatibility-adapter helper: wraps emitEvent so a failure to record the
 * event NEVER breaks the calling module's existing behavior, AND so a
 * merely-HANGING underlying request can never hold the calling legacy
 * workflow open indefinitely (P0.9 Slice C, finding H-01) — the write is
 * raced against TELEMETRY_DEADLINE_MS; past that, this returns `null`
 * immediately without cancelling the underlying operation (which may still
 * complete later — see withTelemetryDeadline). Use this from inside an
 * already-working module (see lib/modules/missedCallRecovery/service.ts)
 * instead of calling emitEvent directly, matching the "graceful fallback"
 * precedent already established in this codebase
 * (docs/constitution/03_MODULE_ARCHITECTURE.md).
 *
 * Returns the recorded event on success so a caller can chain
 * correlationId/causationId to subsequent events in the same logical flow
 * (P0.9 Slice C, finding M-04) — returns `null` on any failure or timeout,
 * which callers must treat as "no causation anchor available," never as an
 * error to propagate.
 */
export async function emitEventSafely(input: EmitEventInput, store?: BusinessEventStore): Promise<BusinessEvent | null> {
  const result = await withTelemetryDeadline(emitEvent(input, store), {
    onLateSettle: (settled) => {
      if (settled.outcome === "rejected") {
        console.error(
          `[business_events] emit ${input.eventType} for tenant ${input.tenantId} failed after its ${TELEMETRY_DEADLINE_MS}ms deadline had already elapsed`,
          sanitizeTelemetryError(settled.error)
        );
      }
    },
  });

  if (result.outcome === "resolved") return result.value.event;
  if (result.outcome === "rejected") {
    console.error(`[business_events] failed to emit ${input.eventType} for tenant ${input.tenantId}`, sanitizeTelemetryError(result.error));
    return null;
  }
  console.error(`[business_events] emit ${input.eventType} for tenant ${input.tenantId} exceeded the ${TELEMETRY_DEADLINE_MS}ms compatibility telemetry deadline — legacy workflow continuing regardless`);
  return null;
}

export async function getRecentEvents(
  tenantId: string,
  opts: { eventType?: string; limit?: number } = {},
  store: BusinessEventStore = defaultStore
): Promise<BusinessEvent[]> {
  return store.listByTenant(tenantId, opts);
}
