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

### Bounded fail-open deadline (P0.9 Slice C, finding H-01)

A caught rejection isn't the whole story: without a finite deadline, an
underlying request that merely HANGS (a stalled DB connection, a network
partition) could still hold the calling legacy request open indefinitely —
just as bad as a thrown error for a serverless function with its own
execution limit. `emitEventSafely`/`recordOutcomeSafely` race their
underlying write against `lib/telemetry/deadline.ts::withTelemetryDeadline`,
a fixed `TELEMETRY_DEADLINE_MS = 3000` (well under Vercel's shortest
function timeout) — past that, they return `null` immediately, WITHOUT
cancelling the underlying operation (there's no cancellation primitive for
a generic Promise; it may still complete later, reported only via a
sanitized, bounded-length log line, never awaited by the caller). This
fail-open deadline applies ONLY to these legacy-compatibility telemetry
helpers — it is a deliberately different trust boundary from the governed
agent-runtime audit path (`lib/agents/*`, `lib/execution/*`), which has
never been made fail-open and Slice C does not change that. See
`lib/telemetry/deadline.test.ts`.

### PII minimization in event payloads (P0.9 Slice B/C — "do not regress")

`business_events` is an orchestration/observability log, not a system of
record — the raw caller phone number, message text, etc. belong in the
module's own History table (`missed_call_recovery_history`, which DOES
hold `caller_phone` — that's its job as the system of record) and never
need to be duplicated into an event's `payload`/`metadata` merely to prove
"this happened." `lib/modules/missedCallRecovery/service.ts`'s event
emission call sites are held to this; see
`lib/modules/missedCallRecovery/service.test.ts` for the regression tests
and `lib/db/crossTableIdempotency.pg.test.ts`'s D.8 test (P0.9 Slice D) for
the real-Postgres confirmation that `business_events` has no dedicated
raw-phone column at all — the schema itself provides nowhere to
accidentally duplicate one into beyond the application-controlled `payload`
jsonb column.

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

## Scan telemetry — operational evidence, not reasoning evidence (P1 Sprint 5)

`estimate.closing_scan_completed` and `estimate.closing_scan_failed`
(`lib/agents/estimateClosing/scanTelemetry.ts`, the only writer) close a
specific observability gap: before P1 Sprint 5, a scheduled Estimate
Closing scan that found zero stalled estimates left **no durable record at
all** — "the cron ran and found nothing" was indistinguishable in the
application database from "the cron never ran," visible only by manually
inspecting Vercel's own HTTP logs.

**These are heartbeats, not agent runs.** A scan-completed event answers
"did the scheduled scan invocation that produced this record actually
execute, and what did it observe" — it is emitted once per tenant with a
registered AND active `estimate_closing` agent, every time the scan runs,
**including a tenant with zero candidates that sweep**. It is emitted from
`lib/agents/estimateClosing/stalledScan.ts::runEstimateClosingShadowSweepWithTelemetry`
(a wrapper around the pre-existing, unchanged
`runEstimateClosingShadowSweep`) — never from a page render, matching this
codebase's existing "never generate a business event from a GET request"
discipline. Multiple tenants scanned in the same sweep get their own
isolated, tenant-scoped record; a tenant not registered for Estimate
Closing at all gets none, even if the cross-tenant candidate query happened
to touch its rows.

**Telemetry is secondary to the scan it describes** — a telemetry write
failure (via `emitEventSafely`, the same compatibility-adapter convention
`lib/modules/missedCallRecovery/service.ts` already uses) can never cause
the scan to re-run, never triggers a second model call, and never flips a
successful scan into an apparent failure or vice versa. Conversely, a
genuine scan-level failure (the candidate read itself throws) always
preserves HTTP failure semantics on the route — telemetry recording is a
side effect of that failure, never a way to paper over it.

**Privacy contract**: both event types carry only bounded counts, a
`scanId` (correlating every telemetry record from one sweep), and — for a
failure — a fixed, sanitized error category (never the raw thrown error
text; see `lib/ai/gateway.ts::normalizeProviderError`'s identical
discipline). Both contracts reuse `forbidRawEstimatePii` (see
`lib/events/contracts.ts`) as defense in depth, even though a scan-
telemetry payload has no path to a customer record at all. Idempotency is
`"not_applicable"` for both — unlike `estimate.stalled`, which must
collapse a re-scan to one permanent event, two genuine cron invocations
producing two completed-scan records is correct, not a duplicate.

The read side (`lib/agents/estimateClosing/operationsReadModel.ts`) never
renders an empty telemetry window as "healthy" — absence of evidence is not
evidence of success. It reports one of three honest states:
`"no_telemetry"` (nothing has ever been recorded), `"observed"` (the most
recent telemetry event is a completed scan), or `"failure_recorded"` (the
most recent telemetry event is a genuine scan failure) — whichever
telemetry type is more recent wins, so a failure recorded after a prior
success is never masked by that earlier success.

## Recommendation follow-through — owner-recorded observation, not an outcome (P1 Sprint 6)

`estimate.closing_recommendation_followthrough_recorded`
(`lib/agents/estimateClosing/followThrough.ts`, the only writer) records
what the tenant OWNER observed happened after a Shadow recommendation: did
they act on it, how, did the customer respond, and what the current
business result is. This is a **different question** from
`estimate.closing_recommendation_reviewed` (P1 Sprint 3), which asks "was
the recommendation good?" — follow-through asks "what actually happened
next?" Neither implies the other: a "would act: yes" review does not mean
the owner ever actually acted, and an actual action does not retroactively
make the review agree.

**Correction semantics — append-only, not update-in-place.** Unlike
`estimate.closing_recommendation_reviewed` (one canonical, idempotency-
deduped event per recommendation, never superseded), follow-through can
legitimately evolve — "later" today can genuinely become "yes" + a
business result next week. `business_events` has no update path
(`BusinessEventStore` is insert/list/getById only), so a real follow-through
story is represented as MULTIPLE events over time, one per submission, with
the read side (`commercialEvidence.ts::resolveCurrentFollowThroughByRecommendation`)
resolving "current" as the most recent one by `occurredAt` — the same
"latest wins" discipline the scan-telemetry read side already uses. The
idempotency key is content-derived (`estimate.closing_recommendation_
followthrough_recorded:<recommendationEventId>:<hash of the four answers>`),
so an exact-duplicate retry (a double-click, a network retry) dedupes to one
row, while a genuine correction (a different answer) is intentionally
allowed to create a new, additional row — nothing is ever deleted or
overwritten.

**Privacy contract**: the payload carries exactly four bounded enum fields
(`actionTaken`, `actionChannel`, `customerResponse`, `businessDisposition`)
plus the `recommendationEventId` anchor — no free-text field exists
anywhere in the type, by construction. `lib/events/contracts.ts` enforces
this shape (including the structural rule that `actionChannel` is required
exactly when `actionTaken === "yes"` and forbidden otherwise) and reuses
`forbidRawEstimatePii` as defense in depth, even though this payload has no
legitimate path to a customer record, message content, or a call
transcript at all.

**Owner authorization**: recording follow-through follows the identical
owner-only, session-resolved trust boundary `estimate.closing_
recommendation_reviewed` already established (`followThroughRoute.ts`) —
`tenantId`/`actorUserId` are always resolved from the authenticated server
session, never from request-body input; a cross-tenant recommendation id
returns the same non-enumerating "not found" whether it belongs to another
tenant or doesn't exist at all.

**What recording follow-through never does**: it never writes to
`outcomes` (see the "Follow-through is not an outcome" section below), never
mutates `leads.status` (a `businessDisposition: "won"` value is an
OWNER-REPORTED observation, never synchronized into the lead record —
see `app/(app)/agentic/estimate-closing/recommendations/[eventId]/page.tsx`'s
discrepancy-surfacing behavior when the two disagree), and has no
dependency on any tool/approval/lead/outcome store — a structural
guarantee pinned by `authorityFreeze.test.ts`.

## Migration strategy

Per the directive: *"Do not migrate every current workflow immediately if
doing so creates unnecessary risk. Introduce the foundation and migrate
incrementally."* P0 wires exactly one module (Missed Call Recovery) as the
proof — see `ARCHITECTURE.md` "The compatibility-adapter pattern." Estimate
Follow-up and future modules adopt this the same way, one PR at a time, not
as a P0 side effect.
