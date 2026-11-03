# AIBO-RD-H001-F01 — FINAL LOCAL HARDENING RESULT

16 October 2026. Scope: isolated local development and an authorized local commit. No push, PR, merge, deployment, hosted database operation, provider change or call.

## 1. Assessment

**CONDITIONAL PASS — local hardening complete; HOLD for hosted integration and autonomous booking.** I01-B1 (inconsistent intake replay) and I01-C1 (historical transfer downgrade) are corrected. All four H001 safety controls remain. A real caller-consent mechanism is still absent; booking remains unavailable in the live composition.

## 2. Verified worktree and branch

Worktree: `/Users/vr/.codex/worktrees/aibo-rd-h001-hardening/ai-backoffice-v1`.

Branch: `codex/aibo-rd-h001-hardening`.

Before editing, all 20 H001 files matched the I01 SHA-256 manifest. The complete inventory was 13 modified tracked files and seven untracked H001 files. Original patch, manifests, failed I01 probes and validation receipts were preserved. Protected worktree identities, status and recovery-package hashes matched I01. No unexplained change or isolation conflict was found. The direct upstream Revenue Desk ref remained at the baseline.

## 3. Exact starting HEAD

`ba8824807c23cc90c8668184f2cafa8ef89fe772` on both the isolated H001 branch and protected Revenue Desk branch at the start. This is the original Revenue Desk baseline. H001 had no implementation commit before F01.

## 4. Intake replay root cause

The old 028 proposal used only the call's input digest to decide a request was unchanged. It locked the canonical lead but did not compare its collected fields with the last accepted voice intake. After an owner changed a lead field, an identical replay skipped both updates and returned success with disagreeing lead/call records. The existing adapter then returned `saved: true`.

## 5. Intake correction implemented

The atomic voice-intake RPC now persists `intake_lead_snapshot`, a normalized JSON array of its nine collected canonical fields: customer name, phone, service address, service type, emergency, urgency, description, preferred time and customer notes. It checks the locked lead against this accepted snapshot before either acknowledging a duplicate or applying a correction.

An exact duplicate with matching authoritative fields remains idempotent, including after unrelated lifecycle changes. A genuine revision-checked customer correction updates the same canonical lead, call intake, revision, snapshot and receipt in one transaction. Old operation identities and conflicting revisions still fail. Lead identity, source/reference and lifecycle fields remain unchanged.

If an owner has independently changed collected fields, both replay and attempted voice correction fail closed rather than overwrite the owner or claim consistency. The RPC writes no receipt or partial correction on rejection. The existing service boundary returns an explicit non-success result, invalidates its in-memory intake and records the persistence exception. A lost acknowledgement can still be retried using the same identity; canonical event deduplication remains unchanged.

Legacy voice leads without an accepted snapshot and missing previously accepted leads also fail closed. The migration deliberately does not manufacture historical snapshots from potentially divergent records. Resolving legacy/drift exceptions needs an approved evidence/authority workflow before those historical calls can accept further corrections. New calls are unaffected. No general lead API or website/manual intake behavior was changed.

Consistency is guaranteed at the serialized transaction boundary, not against arbitrary edits made after that transaction commits. The change adds no automatic overwrite or resynchronization of owner data.

## 6. Transfer downgrade root cause

The old proposal defaulted every historical call's `transfer_final` to false without a backfill. Its trigger consequently allowed late requested/initiated updates to replace outcomes of ended pre-H001 calls. A single mutable outcome also lacked durable detail for contradictory observations.

## 7. Transfer correction implemented

The revised proposal initializes historical terminality from ended timestamp, ended reason, completed/failed call status, or a prior terminal transfer assertion. It classifies explicit documented end reasons conservatively; legacy regex-derived labels without supporting end evidence become unknown. Historical unsupported success and failure assertions are retained separately as `unverified_transferred` and `unverified_transfer_failed`.

A service-only database trigger accumulates a sorted, deduplicated `transfer_evidence` set. It derives the displayed outcome from retained observations and monotonic terminality. Directly supplying an evidence array cannot erase or fabricate observations through the update path. PostgreSQL row serialization makes concurrent updates converge on the same evidence set.

| Evidence | Result |
|---|---|
| Requested, call active | Requested |
| Initiated, call active | Initiated; later request cannot downgrade it |
| `assistant-forwarded-call` | Provider forwarding confirmed; human answer unverified |
| `call.in-progress.error-transfer-failed` | Transfer failed |
| `customer-ended-call-during-transfer` | Unknown, interrupted observation retained |
| Generic end after attempt, without explicit outcome | Unknown |
| Generic end without transfer evidence | No transfer outcome; a late attempt becomes unknown |
| Contradictory forwarding/failure observations | Unknown; both observations retained |
| Unsupported historical terminal assertion | Unknown; original assertion type retained as unverified |

Generic late call-end reports and duplicate/late requests or initiations do not erase documented terminal evidence. Explicit evidence arriving after an ordinary end is evaluated the same way regardless of order. Contradictory evidence is not hidden as success; subsequent duplicates cannot remove it. Failure observations remain owner-visible even if the most recent call-end reason differs.

The existing application sends requested/initiated observations and explicit end-reason classifications. New integration tests execute those actual application functions against the real trigger as service_role. A call-detail row shows readable durable observations. Neither generic transfer notifications nor claimed `humanAnswered` fields establish a human answer.

## 8. Migration 028 compatibility and local results

`028_revenue_desk_hardening.sql` remains an unexecuted hosted **local forward-only proposal**, as specified by Founder authorization. F01 adjusts that proposal; applied historical migrations 001–027 were not rewritten. No hosted ledger was queried or changed.

In addition to the original H001 columns, receipts/RLS, lease-token fencing and booking/call summary trigger, the proposal now includes the intake snapshot, transfer observation set, conservative historical backfill and two pure transfer-classification helpers. Helpers execute only for service_role/postgres; tenant/member write protections remain.

Disposable PostgreSQL 17.11 validation covers:

- Canonical scaffold and 001–028, applied from scratch.
- Preview path using the unchanged reviewed 008 variant, followed by 009–028.
- Equality of normalized schema-only dumps **including ACLs**, excluding ownership and dump session guards.
- A separate real 027-to-028 upgrade with seeded historical forwarding, failure, interrupted, unsupported, ordinary, timestamp-only and status-only cases.
- Atomic preflight rejection for legacy failed `PROVIDER_ERROR` and `CONFLICT_CLEANUP_FAILED` bookings, with no partial new columns.

All canonical 001–027 source hashes and the sanitized Preview 008 hash match the recovery manifest. Variant SHA-256: `0cb39ece06fef17daaae9374aae2c6e74099738ab16ab903d7edcf22ed29e268`.

The existing ambiguous-booking preflight remains intentionally blocking. Do not relabel historical rows to bypass it. Legacy intake with no accepted snapshot is not automatically certified. Hosted schema, grants, data volume and migration history still require M006 reconciliation. Old unfenced writers must be quiesced during any future cutover.

Rollback should disable integration or use compatible safe application behavior while preserving additive evidence. Restoring the old unsafe booking writer is not an acceptable rollback. Dropping evidence or reverting constraints requires an explicit reviewed compensating migration; never rewrite applied history.

## 9. Caller-confirmation gate status

Unchanged and fail closed. `callerConfirmed=true` alone cannot authorize a new booking. The live webhook supplies no independent confirmation adapter, and assistant context advertises `bookingAvailable:false`. Missing, false or unavailable confirmation creates neither a booking row nor a calendar event.

No provider-origin acceptance mechanism was invented. Synthetic confirmation fixtures only exercise downstream booking fault handling and do not prove consent. Persisted offered slots, attributable acceptance, expiry, current-revision checks and atomic single-use consumption remain separate prerequisites. Existing-event reconciliation does not authorize a new event or certify historical customer consent.

Uncertain calendar writes remain pending, cleanup uncertainty remains unresolved, lease takeover performs bounded reconciliation without blind insertion, stale workers are fenced, and owner exceptions remain visible.

## 10. Files changed

The final local commit contains the original H001 patch plus F01: **22 files**.

F01 changes relative to the preserved H001 snapshot are limited to:

- `db/migrations/028_revenue_desk_hardening.sql`: atomic drift guard and durable transfer/backfill rules.
- `lib/revenueDesk/revenueDesk.pg.test.ts`: six intake regressions and explicit end evidence in the existing transition test.
- `lib/revenueDesk/hardeningF01.pg.test.ts`: 19 real upgrade/application-transition tests.
- `lib/revenueDesk/transfer.ts`: readable historical/contradictory evidence labels.
- `app/(app)/revenue-desk/[callId]/page.tsx`: owner-visible evidence row.
- `docs/AIBO-RD-H001-HARDENING-REPORT.md`: historical-report clarification.
- This report.

The complete H001/F01 inventory also includes the overview page and owner action; event contracts; Vapi handler/parser; booking, confirmation, calendar adapter/types and tests; read model; existing domain/recovery tests; service and persistence adapters. The evidence directory's file inventory and reviewed patch enumerate every file and SHA-256. No dependency manifests, environment files, generated build files, migrations 001–027, billing source or unrelated work are included.

## 11. Full test counts and actual results

Final validation: **1,358 tests passed in 98 files; zero failures, zero skips.** The focused H001/F01 run passed **763 tests in 43 files**. These runs overlap; do not add their counts. F01 adds 25 tests: six intake cases and 19 transfer/upgrade cases. TypeScript, lint, local production build and diff whitespace checks passed.

Tests cover initial intake, idempotent duplicate delivery, genuine corrections, accepted revision, stale/rebound requests, concurrent writers, partial rollback/lost acknowledgement, canonical owner drift, lifecycle-only edits, missing/legacy records and cross-tenant denial. Transfer tests cover every requested state, historical finality, duplicate/late/reordered reports, real concurrent contradictions, missing human-answer proof and actual application/database agreement. Existing booking, tenant, billing, no-send, event and lead-lifecycle suites remain in the full run.

Exact final command vectors, working directory, sanitized environment and exit codes are recorded in `h001-f01/final-commands.json`; the reproducible sequence is `h001-f01/verify-local.py`. Commands run from the isolated worktree:

```sh
env -i PATH=/Users/vr/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin HOME=/Users/vr NO_COLOR=1 NEXT_TELEMETRY_DISABLED=1 DATABASE_URL=postgresql://postgres@127.0.0.1:55483/f01_final ./node_modules/.bin/vitest run lib/revenueDesk lib/leads/intake lib/agents lib/events --reporter=default
env -i PATH=/Users/vr/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin HOME=/Users/vr NO_COLOR=1 NEXT_TELEMETRY_DISABLED=1 DATABASE_URL=postgresql://postgres@127.0.0.1:55483/f01_final npm test -- --reporter=default
env -i PATH=/Users/vr/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin HOME=/Users/vr NO_COLOR=1 NEXT_TELEMETRY_DISABLED=1 npm run typecheck
env -i PATH=/Users/vr/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin HOME=/Users/vr NO_COLOR=1 NEXT_TELEMETRY_DISABLED=1 npm run lint
env -i PATH=/Users/vr/.nvm/versions/node/v22.22.3/bin:/usr/bin:/bin HOME=/Users/vr NO_COLOR=1 NEXT_TELEMETRY_DISABLED=1 npm run build
git diff --check
```

The migration runner sends exact scaffold/migration contents to `docker exec -i aibo-rd-h001-f01-pg psql -X -U postgres -v ON_ERROR_STOP=1 -d <disposable_database>`. The committed upgrade suite creates/drops a uniquely named disposable database and explicitly refuses non-local URLs. Existing lint deprecation/multiple-lockfile warnings are recorded; they are not lint errors. Fault-injection logs are expected test output. No skipped suite is counted as passed.

Evidence root: `/Users/vr/.codex/visualizations/2026/10/15/01a14099-9606-7e70-9ab9-1725d46425d8/h001-f01/`. Final receipts use the `final-` prefix. Earlier passing receipts are retained separately; the last run follows the final historical-evidence-label refinement.

## 12. Security and tenant-isolation impact

The intake RPC keeps server-resolved tenant identity, canonical provenance checks, row locks, composite foreign keys, service-only execution and immutable member receipts. It neither accepts a client-chosen tenant nor broadens website/manual persistence. Snapshots duplicate only already-authorized structured intake fields; no transcript or recording is stored. Lifecycle fields do not participate in the snapshot comparison.

Transfer observations enter through the existing authenticated provider boundary and service-role call update; members remain unable to write calls. Confirmation, HMAC validation, agent/tool permission evaluation, no-send behavior, owner-only recovery and booking lease fences were not weakened. New helper execution is not granted to PUBLIC, anon or authenticated roles. Tenant-isolation/RLS and shared billing regressions passed locally.

Local PostgreSQL and provider fakes do not validate hosted PostgREST, real signed Vapi delivery, real Google authorization, human answer or production behavior. No independent external reviewer or subagent review is claimed.

## 13. Final reviewed diff

Reviewed the complete H001/F01 changes against the exact baseline, including new files, final SQL, retained booking controls, audit/privacy boundaries, UI evidence and tests. `git diff --check` passed. The final staged inventory is explicitly allowlisted; generated files, secrets, environments and unrelated changes are excluded.

The exact baseline-to-commit patch and SHA-256 inventory are retained as `reviewed.patch` and `file-inventory.json` in the evidence directory. The earlier H001 patch remains separately preserved; it was not discarded or reset.

## 14. Local commit SHA

The final exact SHA is recorded after commit creation in the external `commit-receipt.json` and finalized copy of this report. This committed source report intentionally does not attempt to embed its own commit hash. Its containing commit must have parent `ba8824807c23cc90c8668184f2cafa8ef89fe772` and branch `codex/aibo-rd-h001-hardening`.

## 15. Clean working-tree confirmation

Final cleanliness, branch, parent, commit SHA and staged/unstaged status are verified after commit creation and recorded in `commit-receipt.json`. No push, PR or merge is part of that operation. Build/test outputs and external receipts are excluded from the commit. The protected Revenue Desk and original project worktrees, Claude worktree status and recovery-package hashes are compared with the pre-F01 receipt.

## 16. Outstanding hosted and provider blockers

- Real caller-confirmation evidence remains unavailable; autonomous booking stays blocked.
- Hosted schema/ledger, grants and backfill review remain pending M006 reconciliation.
- Existing read-only Vapi evidence shows unverified effective assistant/tool URL and credential bindings, HMAC interoperability and transfer subscription/delivery.
- Twilio number connection/routing and Google Calendar authorization remain unverified.
- Cleanup/conflict and legacy-intake exceptions need an approved operator evidence workflow and ownership.
- Human-answer evidence is absent. Provider forwarding is not a human answer.
- No hosted end-to-end receptionist or reconciliation test ran. Classic remains the baseline; GPT-Live evaluation remains independent.

## 17. Integration dependencies with Claude M006

Claude's worktrees and sanitized Preview 008 recovery package were neither edited nor reset. No message or action was dispatched to Claude. Documentary M006 status remains separate from this local result; no fresh hosted-ledger claim is made.

Before integration, reconcile the actual Preview ledger and schema through 027, preserve the separately named 008 variant, verify migration numbering/ownership and any concurrent source changes, review historical data and define a coordinated cutover with old writers stopped. Do not run bulk migration synchronization or replay canonical 008 against Preview. Production `yohfpsaemgibarlgodmh` and Preview `wasugleumzcigegeuyua` remain untouched.

## 18. Exact next Founder authorization

Recommended next decision:

> Approve local integration preparation of the exact F01 commit in a separate integration worktree, with read-only reconciliation of the current Revenue Desk baseline and M006 evidence, and a reviewed Preview migration/cutover/rollback plan. Preserve Classic Vapi and the fail-closed confirmation gate. Do not push, open a PR, merge, execute hosted migrations, deploy, change provider resources, place calls or enable booking under this authorization.

Hosted migration/deployment and controlled provider validation require later explicit approval after M006 is reconciled. Designing and validating real caller consent, and resolving historical intake/booking exceptions, require separately bounded authorization. This mission stops after local commit verification and Founder review.
