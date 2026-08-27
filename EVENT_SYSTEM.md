# Event System — P0.5

## Purpose

`business_events` is the canonical, tenant-scoped record of "something
happened" — independent of which module or agent cares. It is what lets the
future Supervisor Agent (and, today, the P0 demonstration) trigger off of
and reconstruct "what happened" without every module having to know about
every other module or agent.

## It is not a replacement for module History tables

`docs/constitution/06_DATABASE_PRINCIPLES.md` says: *"Do not collapse all
module history into one generic 'events' table — module-specific columns...
need first-class columns, not a JSON blob."* That rule is about
`missed_call_recovery_history` / `estimate_followup_history` and their
successors: the business-outcome-facing, first-class-columned,
customer-relevant record of what a module did (per
`docs/constitution/03_MODULE_ARCHITECTURE.md`'s History layer). Those tables
are untouched and remain the source of truth for module-level Analytics.

`business_events` is a second, separate thing: a JSONB-payload,
cross-module orchestration log, read by infrastructure (the agent runtime,
future dashboards of "what happened across the whole account"), not by a
module's own Analytics queries. This is a deliberate, dated amendment — see
`docs/constitution/06_DATABASE_PRINCIPLES.md`'s "P0 Amendment" section —
not a silent contradiction of the existing rule.

## Envelope

```ts
{
  id, tenantId, eventType,            // e.g. "call.missed", "lead.created"
  actorType,                          // 'user' | 'system' | 'agent' | 'integration'
  actorId,
  entityType, entityId,               // polymorphic — see DOMAIN_MODEL.md
  correlationId, causationId,         // chain of causation
  idempotencyKey,                     // optional — see Idempotency below
  payload, metadata,                  // jsonb
  occurredAt, createdAt,
}
```

`eventType` is free text at the database layer (no migration needed to add
a new event type) but centralized in `lib/events/types.ts`'s
`KNOWN_EVENT_TYPES` so producers and future consumers agree on spelling.

## API

```ts
import { emitEvent, emitEventSafely, getRecentEvents } from "@/lib/events/service";

await emitEvent({ tenantId, eventType: "lead.created", entityType: "lead", entityId, payload });
```

- `emitEvent` is the only supported write path — never insert into
  `business_events` directly from a module.
- `emitEventSafely` wraps `emitEvent` in try/catch and logs on failure
  instead of throwing. **Use this from inside an already-working module**
  (see `lib/modules/missedCallRecovery/service.ts`) — a business event must
  never be able to break a real customer-facing action.

## Idempotency

Pass `idempotencyKey` for any event whose source might redeliver (a Twilio
webhook retry, a cron re-scan, a queue redelivery). `(tenant_id,
idempotency_key)` has a unique partial index (migration `009`) — that index
is the actual guarantee; the store's pre-check on a unique-violation is
just a fast path to return the original event instead of raising. See
`lib/events/service.test.ts` for the tested contract, including that the
same key is independent per tenant.

## Testing

- `lib/events/service.test.ts` — idempotency, `emitEventSafely` never
  throwing, filtering/limiting.
- `lib/tenantIsolation.test.ts` — cross-tenant leakage is impossible through
  the store's `listByTenant`/`getById`.
- Both use `InMemoryBusinessEventStore` (`lib/events/store.ts`), which
  implements the identical `BusinessEventStore` interface (and identical
  tenant-filtering/idempotency semantics) as `SupabaseBusinessEventStore` —
  dependency-injected everywhere so tests never touch the live database.

## Migration strategy

Per the directive: *"Do not migrate every current workflow immediately if
doing so creates unnecessary risk. Introduce the foundation and migrate
incrementally."* P0 wires exactly one module (Missed Call Recovery) as the
proof — see `ARCHITECTURE.md` "The compatibility-adapter pattern." Estimate
Follow-up and future modules adopt this the same way, one PR at a time, not
as a P0 side effect.
