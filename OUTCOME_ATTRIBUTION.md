# Outcome + Revenue Attribution — P0.8

## Purpose

Connect system/agent activity to measurable business results, honestly.
The long-term dashboard language should move from *"37 messages sent"* to
*"$18,420 recovered by AI BackOffice"* — P0 builds the data foundation for
that claim to be true, not the claim itself.

## Schema

`outcomes` (migration `015`): `workflow_id`, `agent_run_id`, `entity_type`/
`entity_id` (polymorphic — see `DOMAIN_MODEL.md`), `outcome_type`,
`outcome_value`, `currency`, `attribution_confidence`, `occurred_at`,
`metadata`. Migration `019` (P0.9 Slice C, finding C.3; written, reviewed,
**not yet applied to production**) adds `idempotency_key` + a matching
`UNIQUE (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
partial index — a repeated webhook, event replay, retry, or compatibility
callback for the SAME logical evidence must not create a duplicate
outcome. `idempotency_key` is derived from stable EVIDENCE identity, never
current time — e.g. `lead-recovered:<leadId>:<evidenceType>:<evidenceId>`
for a future real `lead_recovered` outcome (see `lib/outcomes/service.ts::recordOutcome`).
`NULL` is valid — not every outcome has a stable evidence identity yet.
See `lib/outcomes/idempotency.pg.test.ts` (P0.9 Slice D, real Postgres
proof: a concurrent duplicate-key insert dedupes to one row via
`uq_outcomes_tenant_idempotency`; a different tenant with the same key
gets a separate row; two `NULL`-key rows are never treated as duplicates).

```ts
type OutcomeType =
  | "lead_recovered" | "appointment_booked" | "estimate_reengaged"
  | "estimate_won" | "revenue_recovered" | "invoice_collected"
  | "review_generated" | "admin_time_saved" | "other";
```

## Attribution confidence — the honesty mechanism

```ts
type AttributionConfidence = "direct" | "assisted" | "inferred" | "unknown";
```

- **direct** — the system's action was the proximate cause (the recovery
  SMS a customer replied to, leading straight to a booked job).
- **assisted** — the system contributed materially, but a human step also
  mattered.
- **inferred** — correlates with system activity but causation isn't
  directly observed.
- **unknown** — recorded for completeness; never surfaced in ROI totals.

`lib/outcomes/service.ts::recordOutcome()` **requires**
`attributionConfidence` on every call — there is no default, and no
codepath that records a dollar value without one. `summarizeOutcomeValue()`
sums by tier and returns them **separately**, never blended, specifically
so a future dashboard can headline `direct` (+ explicitly-labeled
`assisted`) without silently folding in `inferred`/`unknown` numbers — see
the "Do not invent fake ROI" line in the P0 directive itself.

## API

```ts
import { recordOutcome, recordOutcomeSafely, summarizeOutcomeValue } from "@/lib/outcomes/service";

await recordOutcome({
  tenantId, agentRunId, entityType: "lead", entityId,
  outcomeType: "lead_recovered",
  attributionConfidence: "direct",
});
```

`recordOutcomeSafely` mirrors `emitEventSafely` — never throws, logs on
failure — for use from inside an already-working module (see the Missed
Call Recovery wiring below).

## Wired into a real workflow — and the correction that matters (P0.9 Slice C, finding H-03)

An earlier version of `lib/modules/missedCallRecovery/service.ts::executeMissedCallRecovery()`
recorded a canonical `lead_recovered` outcome whenever the recovery SMS
successfully sent. **That was wrong and has been corrected — this is an
explicit "do not regress" invariant for every P0.9 slice since.** Sending a
message proves the system ACTED, not that the customer engaged, replied,
booked, or generated revenue. The module now instead emits a
`business_events` row (`recovery.sms_sent`, an *operational* event — see
`EVENT_SYSTEM.md`) and writes the legacy `missed_call_recovery_history`
row's `status` column as `'recovered'` (kept verbatim for backward-
compatible analytics/UI — see `computeOverallStatus` in that file) — but
**no canonical `lead_recovered` outcome is emitted from an outbound SMS
send.** The legacy History string `"recovered"` and the canonical outcome
type `lead_recovered` are deliberately different claims: the former means
"recovery SMS successfully sent," the latter would mean "the customer
actually re-engaged," which this module cannot currently observe. No
evidence path for real re-engagement exists yet in this repository, so
none is fabricated — see `lib/modules/missedCallRecovery/service.ts`'s own
doc comment on `executeMissedCallRecovery` for the full record, and
`lib/modules/missedCallRecovery/service.test.ts` for the regression test
pinning this. **No outcome type is currently recorded by production code**
— every outcome type exists in the schema and type system, ready for P1
agents, but nothing fabricates data for any of them today.

## Testing

- `lib/tenantIsolation.test.ts` — outcome rows never leak across tenants,
  including their dollar values.
- `lib/agents/runtime.test.ts` — an outcome recorded against a completed
  `agent_run`, closing the P0 exit-criteria chain.

## Deferred

- No revenue dashboard yet (P1 — "Prove measurable business ROI with the
  Estimate Closing Agent" per the directive's roadmap).
- No automatic inference of `estimate_won`/`invoice_collected` from status
  changes — those need the Job/Invoice domain model work described as
  deferred in `DOMAIN_MODEL.md`.
