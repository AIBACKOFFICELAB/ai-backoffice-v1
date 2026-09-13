# Estimate Sent lifecycle incident and reconciliation hotfix

## Proven root cause

Accepted incident baseline: 5b94289f551b3ea4ee7cf6b8d2a145737fe1c14a (PR #27).
The authenticated PUT at 2026-09-13T22:36:44.891Z returned HTTP 200 while logging
"[estimate-followup] enrollment failed for lead". Its lead update persisted at
22:36:45.897Z, but the sequence and estimate.sent event were absent.

Production policies on estimate_followup_sequences and estimate_followup_history
were SELECT-only, as created by migration 005. Later migrations did not add their
write policies. Migration 007 restored the membership helper's EXECUTE privilege;
020 revoked only anonymous EXECUTE. Authenticated table grants are present, so
this is an RLS denial, not a missing table grant. business_events likewise has
only a tenant SELECT policy.

The installed @supabase/ssr and supabase-js were reproduced with synthetic cookies
and intercepted fetch: a valid session cookie selects its access token for the
Authorization header, even when createServerClient receives the service key.
Without a cookie, the key is the fallback. No production token was inspected.
A real local PostgreSQL transaction, under authenticated with a genuine fixture
membership and baseline-equivalent policies, returned SQLSTATE 42501:
"new row violates row-level security policy for table estimate_followup_sequences".
The production logger discarded the underlying error; the precise category comes
from this controlled reproduction, not an invented production log message.

## Blast radius and correction

| Operation | Before | Correction |
|---|---|---|
| Authenticated enrollment | RLS INSERT denied | Tenant-member sequence INSERT policy |
| Authenticated sequence updates | No matching UPDATE policy; zero rows possible | Tenant-member UPDATE policy; check affected row |
| Authenticated history writes | RLS INSERT denied | Matching tenant/sequence/lead INSERT policy; check error |
| Authenticated manual Day 1/3/7 scan | Same denied writes after selecting own tenant | Same scoped policies; timing/templates/sender unchanged |
| Reply handling with session cookies | Same update/history mismatch | Same policies and explicit write-error handling |
| Normal cookie-free cron/reply webhook | Service-role fallback; this denial not established | Existing role behavior preserved; explicit tenant filters and error checks |
| estimate.sent from authenticated save | Would fail after enrollment was fixed | Private server-only event adapter |
| Other modules | Shared SSR behavior exists; no module-specific incident proven | No global client or unrelated-module changes |

Migration 024_estimate_followup_lifecycle_write_policies.sql adds only authenticated
INSERT/UPDATE on sequences and INSERT on history. Membership must hold and related
lead/sequence references must match the row's tenant. UPDATE checks both visibility
and the resulting row. Existing SELECT policies remain. No DELETE policy, anonymous
write policy, grants, RLS disabling, data backfill, or production reconciliation.

The event adapter exposes only emitEstimateSentEvent, not its elevated client.
It re-resolves verified user/tenant context and checks the persisted Estimate Sent
lead/positive amount and sequence through the request's RLS client. Only then does
a private cookie-free client use the existing governed event store and fixed
estimate.sent contract/key. Arbitrary authenticated business-event INSERT remains
denied. Intake v2 and the shared SSR client are unchanged.

## Truthful API/UI behavior

The persisted lead is never rolled back on a lifecycle failure. HTTP 503 carries
leadPersisted=true, estimateLifecycleComplete=false, an explicit enrollment_failed,
event_failed or lifecycle_failed outcome, and a sanitized retry message. Both
sequence and event failures are visible. Successful Estimate Sent saves carry
estimateLifecycleComplete=true. The UI clears old Saved! state, displays the
incomplete-setup message and refreshes persisted data. A 200 response that explicitly
says incomplete is also handled defensively.

Enrollment/event writes remain separate durable operations. Safe re-save repairs
either gap using UNIQUE(tenant_id,lead_id) and estimate.sent:<leadId>. No new
scheduler, repair agent or transaction rollback mechanism is introduced.
Sequence/history write errors are now surfaced rather than silently reporting a
successful reply/step. This does not add guaranteed SMS delivery or atomic
provider-send/database-write semantics; the pre-existing timing and SMS behavior
remain unchanged.

## Safe recovery after separate Founder deployment approval

1. Review and accept this PR. Do not mutate the affected lead during development.
2. Apply accepted migration 024 through the approved production mechanism and
   deploy the accepted hotfix after the separately authorized merge.
3. In normal authenticated Lead Detail, re-save the affected lead with its existing
   Estimate Sent status and existing amount/date; do not toggle away and back.
4. Expect already_sent_reconciled if the sequence is still absent, one sequence
   and one privacy-safe estimate.sent. If the event alone is missing, the same
   save repairs the event without recreating the sequence.
5. Verify counts/read model and truthful UI response. Do not invoke cron or Shadow,
   send a manual SMS, insert SQL rows, or modify timestamps.
6. The new estimate_sent_at is the recovery/enrollment time, NOT the original
   failed owner-save time. Day 1/3/7 are measured from that recovery time. The
   optional follow_up_date does not replace that existing sequence timing rule.
   With automation enabled, normal future cron execution can send follow-up SMS.

## Validation boundary

Regression tests execute the production PUT, enrollment, event store, manual
processing and reply service against real PostgreSQL roles/RLS. The test query
transport issues actual SQL and SET LOCAL ROLE, not an in-memory policy simulation.
Actual installed SDK header behavior is independently exercised with synthetic
cookies/intercepted fetch. API authentication/tenant seams use synthetic identities;
these are not a claim of a full hosted Supabase Auth/browser test.

Tests cover new canonical intake leads, reconciliation, existing rows, concurrent
retry, actual RLS-induced sequence/event failures, tenant/reference isolation,
authenticated Day 1 processing, reply/history handling, cookie-free service-role
permissions, and migration repeatability. UI tests invoke the real submit handler
and inspect rendered success/error states. SMS is always faked; production data is
never used in tests.

Prior baseline: 940. Final counts recorded in the PR/Founder report after checks.
Shadow remains active; allowedTools=[], writeScopes=[], approvalPolicy={}.
Human Approval remains unauthorized. P2 is not started. No production migration,
sequence, history, estimate.sent, agent run, tool/model call, approval or outcome
is created by this development work.

Final local checks: typecheck, lint, build and diff check pass. Ordinary suite:
851 passed, 113 DB skips (964 total). Fresh-PostgreSQL suite with migrations
001–024: 964 passed, zero skipped, using --maxWorkers=1 and 127.0.0.1.
This preserves all 940 baseline tests and adds 24. Earlier parallel local runs
hit five-second timeouts in existing DB tests; the complete bounded-worker run
passed without changing any timeout/assertion or disabling concurrency inside
the race tests. No privileged credential identifier appears in .next/static.
