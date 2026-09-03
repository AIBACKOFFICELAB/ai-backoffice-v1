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

## Scan telemetry, recommendations, and owner reviews are NOT outcomes (P1 Sprint 5)

P1 Sprint 5 adds durable scan telemetry (`estimate.closing_scan_completed`/
`estimate.closing_scan_failed` — see `EVENT_SYSTEM.md`) and a first-
recommendation evidence packet
(`lib/agents/estimateClosing/recommendationEvidence.ts`). Neither writes,
nor is ever conflated with, a canonical `outcomes` row:

- **A scan-completed event** proves the scheduled scan invocation ran and
  what it observed — an operational fact about the *system*, never a claim
  about the *business*. It carries no `outcome_value`, no
  `attribution_confidence`, and is never read by any outcome-summing code
  path.
- **A recommendation** (`estimate.closing_recommendation_generated`) proves
  the model reasoned about a stalled estimate — this was already true since
  P1 Sprint 2 (see "Wired into a real workflow" above) and remains
  unchanged. `recommendation generated != customer acted != job won !=
  revenue recovered`.
- **An owner review** (`estimate.closing_recommendation_reviewed`, P1
  Sprint 3) proves a human evaluated the recommendation's quality — this is
  evaluation EVIDENCE, not evidence the recommendation was ever acted on.
  The owner saying "would act" does not itself create `estimate_won`,
  `estimate_reengaged`, or `revenue_recovered` — no code path in this
  sprint, or any prior one, does that.

The Recommendation Detail experience
(`app/(app)/agentic/estimate-closing/recommendations/[eventId]/page.tsx`)
makes this explicit with a restrained evidence ladder: *AI recommendation:
RECORDED · Owner review: RECORDED/NOT YET · Customer response evidence: NOT
OBSERVED · Revenue attribution: NOT ESTABLISHED*. This is evidence-STATE
UX — it displays facts about what has and hasn't been observed, and
creates or infers no outcome, ever. `opportunityValue` (the estimate's own
dollar amount, carried through a recommendation) remains, as always, an
observation of what AI noticed — never a claim of recovered or won
revenue; nothing in this sprint changes that boundary or adds a new dollar
figure anywhere.

## Follow-through is not an outcome (P1 Sprint 6)

P1 Sprint 6 adds owner-recorded recommendation follow-through
(`estimate.closing_recommendation_followthrough_recorded` — see
`EVENT_SYSTEM.md`) and a commercial evidence read model
(`lib/agents/estimateClosing/commercialEvidence.ts`). Neither writes a
canonical `outcomes` row, and neither is ever conflated with one — this
sprint adds **zero** new outcome writers. `authorityFreeze.test.ts` pins
this structurally: `followThrough.ts` and `commercialEvidence.ts` import no
`OutcomeStore` and call no `recordOutcome`.

**The constitutional attribution rule this sprint enforces throughout:**

```
AI recommendation != owner review != owner action != customer response
!= estimate won != AI-caused revenue
```

No stage automatically implies the next. Concretely:

- **A recommendation review's `wouldAct: "yes"`** is the owner's stated
  INTENT at review time — it has never meant, and still does not mean, the
  owner actually acted. Sprint 6 adds the missing evidence for the real
  question ("did you act on this?") as an entirely separate, later,
  optional record — it never reinterprets `wouldAct` as `actionTaken`.
- **`actionTaken: "yes"`** means the owner reports they followed up. It
  does not imply the customer responded — `customerResponse` is recorded
  independently and can be "unknown" even when `actionTaken` is "yes".
- **`customerResponse: "observed"`** means a response was noted. It does
  not imply the business was won — `businessDisposition` is a separate
  field, and the read model's diagnostics (`commercialEvidence.ts`) flag
  (never auto-correct) the internally-unusual case of a response observed
  without a recorded action.
- **`businessDisposition: "won"`** is an OWNER-REPORTED, self-attested
  observation about the current state of the deal — not a canonical,
  attributed `estimate_won` outcome. It creates no `outcomes` row, and
  `attributionConfidence` is never assigned to it. A dashboard or workspace
  surface may say "owner-reported wins" — it must never say "AI wins",
  "revenue recovered", or state/imply a conversion rate this figure does
  not support (see `commercialEvidence.ts`'s `followThroughCoverageRate`,
  deliberately named with its denominator explicit rather than "conversion
  rate").
- **Owner-reported "won" is NEVER direct AI attribution.** Even a
  `businessDisposition: "won"` recorded immediately after `actionTaken:
  "yes"` and `customerResponse: "observed"` does not establish that THIS
  recommendation caused the win — a walk-in, a referral, or unrelated
  timing could equally explain it. Establishing genuine `direct`
  attribution requires the same rigor every other `direct` outcome in this
  codebase requires (see "Attribution confidence" above) — self-reported
  sequence-of-events is not causal proof.

**The pure evidence-ladder resolver**
(`commercialEvidence.ts::resolveEstimateClosingAttributionState`) makes
this explicit in code, not just prose: it returns an `evidenceStage` (how
far the OBSERVED evidence chain reaches — RECOMMENDATION_RECORDED through
BUSINESS_DISPOSITION_OBSERVED) as a field entirely SEPARATE from
`attributionStage`, which this sprint hardcodes to
`"ATTRIBUTION_NOT_ESTABLISHED"` — a type-level constant, not a runtime
computation — regardless of how far the evidence ladder reaches. It is
literally impossible for this sprint's code to report an established
attribution; a future sprint that adds a real canonical-outcome path would
have to deliberately widen that type, not silently repurpose it. See
`app/(app)/agentic/estimate-closing/recommendations/[eventId]/page.tsx`'s
Attribution evidence ladder, which renders `evidenceStage`'s progress
per-row while always showing "Revenue attribution: NOT ESTABLISHED".

**Lead status is a separate evidence system, never silently synchronized.**
`leads.status` transitions through the ordinary lead-management flow, with
zero causal connection to a recommendation or its follow-through. Recording
`businessDisposition: "won"` never writes `leads.status = "Won"`, and vice
versa — when the two disagree (e.g. follow-through says "Won" but the lead
is still "Estimate Sent"), the recommendation detail page surfaces a
bounded discrepancy note rather than auto-correcting either record; see
`computeEstimateClosingCommercialEvidence`'s `disposition_lead_status_
mismatch` diagnostic.

**Trust-promotion evidence boundary.** `ApprovalReadinessEvidence` (P1
Sprint 3) now also surfaces follow-through coverage, observed customer
responses, and observed business dispositions as additional FACTS — still
with no computed threshold, no readiness score, and no automatic promotion
logic. Human Approval Mode remains NOT AUTHORIZED regardless of how much
evidence accumulates; that a canonical-outcome-free evidence trail exists
is itself the honest thing to display ("Evidence available for founder
decision" — never "Ready for Approval Mode").

## Deferred

- No revenue dashboard yet (P1 — "Prove measurable business ROI with the
  Estimate Closing Agent" per the directive's roadmap).
- No automatic inference of `estimate_won`/`invoice_collected` from status
  changes — those need the Job/Invoice domain model work described as
  deferred in `DOMAIN_MODEL.md`.
