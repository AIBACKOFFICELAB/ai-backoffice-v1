import { BusinessEvent, EmitEventInput } from "./types";
import { BusinessEventStore, SupabaseBusinessEventStore } from "./store";

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
  return store.insert(input);
}

/**
 * Compatibility-adapter helper: wraps emitEvent so a failure to record the
 * event NEVER breaks the calling module's existing behavior. Use this from
 * inside an already-working module (see
 * lib/modules/missedCallRecovery/service.ts) instead of calling emitEvent
 * directly, matching the "graceful fallback" precedent already established
 * in this codebase (docs/constitution/03_MODULE_ARCHITECTURE.md).
 */
export async function emitEventSafely(input: EmitEventInput, store?: BusinessEventStore): Promise<void> {
  try {
    await emitEvent(input, store);
  } catch (error) {
    console.error(`[business_events] failed to emit ${input.eventType} for tenant ${input.tenantId}`, error);
  }
}

export async function getRecentEvents(
  tenantId: string,
  opts: { eventType?: string; limit?: number } = {},
  store: BusinessEventStore = defaultStore
): Promise<BusinessEvent[]> {
  return store.listByTenant(tenantId, opts);
}
