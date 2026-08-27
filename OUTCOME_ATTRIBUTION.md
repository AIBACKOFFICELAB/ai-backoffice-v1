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
`metadata`.

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

## Wired into a real workflow (P0's one compatibility-adapter proof)

`lib/modules/missedCallRecovery/service.ts::executeMissedCallRecovery()`
records a `lead_recovered` outcome with `attributionConfidence: 'direct'`
whenever the recovery SMS actually sends — the module's own action *is*
the cause, with no intermediate human step, which is exactly what `direct`
means. This is the only outcome currently recorded by production code; every
other outcome type exists in the schema and type system, ready for P1
agents, but nothing fabricates data for them today.

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
