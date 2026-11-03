# AIBO-RD-H001 — SHARED BACKEND HARDENING REPORT

Historical H001 milestone report. The later I01 review found two residual defects; the corrections, final validation and local commit outcome are documented in `AIBO-RD-H001-F01-RESULT.md`. Statements below about an uncommitted patch and 738 tests describe the original milestone, not the final F01 state. Original report bytes and patch remain preserved in the H001/I01 evidence directories.

October 15, 2026. **CONDITIONAL PASS for isolated local hardening; HOLD for hosted integration and autonomous booking.**

The four findings are addressed with fail-closed booking authorization, atomic intake corrections, explicit transfer evidence, and non-final booking recovery. No production confirmation issuer is available or implemented. This patch deliberately prevents new automatic calendar bookings through the live Vapi adapter. Positive booking tests use an explicitly synthetic trusted-boundary fixture; they do not establish caller consent or live-provider readiness.

## 1. Isolated branch and worktree

- Branch: `codex/aibo-rd-h001-hardening`.
- Persistent managed worktree: `/Users/vr/.codex/worktrees/aibo-rd-h001-hardening/ai-backoffice-v1`.
- Changes remain uncommitted for Founder review. No push, merge, deployment, hosted migration, environment change, provider configuration change, or paid session occurred.
- Dependencies reference the existing installed packages through an ignored local `node_modules/` directory. No dependency manifest or lockfile changed.
- Claude's `/Users/vr/Projects/aibo-revenue-desk` worktree was not switched or edited. It remains clean on `feature/revenue-desk-hosted-preview` at the approved baseline. The original hotfix worktree also remains clean. M006 and its recovery files were untouched.

## 2. Verified starting commit

`git ls-remote origin refs/heads/feature/revenue-desk-hosted-preview` returned **`ba8824807c23cc90c8668184f2cafa8ef89fe772`** before any source modification. The independent worktree was created at that commit, the dedicated branch was established, and its clean status and HEAD were verified before editing. HEAD remains that starting commit; the patch is the local working-tree diff.

## 3. Root causes

| Finding | Confirmed root cause | Corrective boundary |
|---|---|---|
| A — caller confirmation | The booking tool's `callerConfirmed:true` was sufficient to reach a calendar write. HMAC proves provider origin, not caller agreement. | Require a separate server-owned confirmation-consumption boundary. The live adapter has no trusted issuer, so new writes fail closed. |
| B — corrections | Canonical duplicate intake returned the old lead while the call was separately overwritten with new details and reported saved. | One tenant-scoped transaction updates the same lead and call, checks the expected revision, and persists a replay receipt. |
| C — transfer | Regex inference missed `assistant-forwarded-call` and treated disconnection during transfer as success. The no-route callback promised an unrecorded callback. | Explicit outcome mapping, serialized database transitions, and truthful no-route language. Provider forwarding never means a human answered. |
| D — interrupted booking | Empty reads after write timeouts and cleanup failures could become definitive failure; expired leases could issue another insertion; owner follow-up depended on a surviving handler. | Pending remains pending, lease takeover only reconciles, stale writers are fenced, and the pending booking table independently supplies the owner queue. |

These are implementation findings, not claims that a customer incident occurred. Independent live caller-confirmation and human-answer evidence remain unverified provider requirements.

## 4. Files changed

| Files | Purpose |
|---|---|
| `lib/revenueDesk/confirmation.ts` | Typed independent confirmation boundary and consumption requirements; no live issuer. |
| `lib/revenueDesk/booking.ts`, `calendar/types.ts` | Fail-closed new bookings; fenced, bounded reconciliation; truthful ambiguous outcomes. |
| `lib/revenueDesk/calendar/google.ts` | Refuse incomplete/duplicate marker evidence and incomplete overlap pages; exclude cancelled/transparent confirmations. |
| `lib/revenueDesk/service.ts`, `store.server.ts` | Atomic intake adapter, revision propagation, transfer handling, lease-aware writes, owner reconciliation lookup. |
| `lib/revenueDesk/transfer.ts` | Explicit provider outcome mapping and owner labels. |
| `lib/integrations/vapi/parse.ts`, `handler.ts` | Transfer notification handling and no-route response. |
| `lib/revenueDesk/readModel.ts` | Pending exceptions independent of call-end/follow-up; evidence-read failures remain explicit. |
| `app/(app)/revenue-desk/page.tsx`, `[callId]/page.tsx`, `actions.ts` | Owner queue, truthful status labels, authenticated owner evidence-check action. |
| `lib/events/contracts.ts` | Allowlisted reconciliation and transfer-initiation audit events. |
| `db/migrations/028_revenue_desk_hardening.sql` | Proposed additive transaction, receipt RLS, atomic correction RPC, transfer transition trigger, lease fences, atomic booking/call confirmation. |
| `lib/revenueDesk/revenueDesk.test.ts`, `revenueDesk.pg.test.ts`, `calendar/google.test.ts`, `recoveryAction.test.ts` | Regression, provider-boundary, owner authorization and real database tests. |
| This report | Design, evidence, limitations, and next decision. |

Nineteen implementation/test/migration files plus this report. Existing migrations 001–027, canonical website/manual intake code, HMAC verification, agent permissions, provider resources, and deployment configuration were not changed.

## 5. Implementation details

### A — fail closed until independent evidence exists

The old model boolean remains a compatibility input but cannot authorize creation. Before inserting a new pending booking, the domain requires `CallerConfirmationStore.consume` for the exact tenant, call, lead, intake revision, calendar, normalized start/end, timezone, and booking idempotency key. Missing, negative, or unavailable independent evidence returns `CONFIRMATION_UNAVAILABLE`, with zero new booking rows and zero calendar writes. The production route supplies no confirmation store. Assistant context advertises `bookingAvailable:false`.

The future adapter contract is deliberately not implemented from a model response, generic transcript, HMAC, or an invented Vapi event. To activate it, a separate approved design must provide:

1. A persisted server-owned offered slot and intake revision, committed before the offer is used.
2. Authenticated evidence of an affirmative response, from a channel independently capable of establishing caller agreement to that exact offer. A provider-authenticated transcript alone does not establish its semantic meaning.
3. A bounded expiry checked with database time. A proposed maximum of 120 seconds after the offer requires Founder/provider validation; it is **not an active control or approved policy**.
4. Durable evidence identity, provenance, decision, and binding; no model-generated approval token. Ambiguous, negative, absent, replayed, expired, or mismatched evidence refuses the write.
5. Atomic single-use consumption, with replay allowed only for the same booking idempotency key. Intake revision changes revoke unconsumed offers; changing slot/duration requires fresh evidence. Issuance, consumption and correction must serialize to prevent a revision race.

The interface specifies this boundary, not a completed consent system. No evidence table, issuer endpoint, manual override, environment switch, or incoming keypad assumption was added. Reconciliation of existing rows remains possible without authorizing a new insert.

### B — canonical correction transaction

The adapter still invokes the existing canonical intake validator and `lead.created` event workflow, with notifications explicitly disabled. Its Revenue Desk persistence implementation now invokes a narrow RPC that locks the tenant's call, checks provenance and revision, updates or inserts the canonical voice lead, updates call intake, and writes the receipt in one transaction.

Only collected intake fields are updated on an existing lead. Lead identity, source/reference, received time, lifecycle status, estimate amount, internal notes, SMS state and other lifecycle columns survive. Website/manual duplicate handling is unchanged. Identical current intake is idempotent; conflicting stale revisions and superseded/rebound tool IDs fail. Corrections never reschedule an existing calendar event.

If the transaction fails, neither record changes. If the response or subsequent governed event acknowledgement fails, the handler does not claim success and invalidates its in-memory intake context; a retry with the same operation identity can acknowledge committed state without duplicating a lead. The canonical event remains replay-healable under the existing contract. The transaction's receipts provide durable revision evidence even if secondary Revenue Desk audit emission is unavailable.

### C — evidence states

- Requested: business escalation or a server-resolved destination request.
- Initiated: authenticated `transfer-update` notification; caller/model claims of `humanAnswered` are ignored.
- Confirmed provider outcome: `assistant-forwarded-call` maps to stored `transferred`, labeled **“Provider forwarding confirmed; human answer unverified.”**
- Failed: documented `call.in-progress.error-transfer-failed`.
- Unknown: `customer-ended-call-during-transfer`, unrecognized outcomes after an attempted transfer, conflicting terminal evidence, or a late attempt notification after an ordinary call-end.

A database trigger serializes duplicate and out-of-order updates. Requested/initiated cannot downgrade terminal evidence; contradictory terminal outcomes become sticky unknown. Duplicate ordinary call-end reports do not invent a transfer. A destination response alone is only requested, not initiated. The no-route response asks the caller to contact the business again and makes no unrecorded callback promise. Existing durable callback reasons remain intact.

### D — reconciliation and owner evidence

An expired lease grants one reconciliation pass, never another insert. Lease acquisition rotates a database token; subsequent writes require that token and pending status. An original worker returning after takeover cannot finalize the row. Timeouts, empty marker lookups, mismatched/missing/duplicate own-event evidence, and database finalization errors remain pending.

Cleanup intent and the event reference must persist before deletion. A cleanup timeout or failed final persistence remains `CONFLICT_CLEANUP_PENDING`; it cannot later become confirmed just because a conflicting event disappears. Such rows require independent operator review. Positive confirmation requires exactly one matching marker/event with the expected times, a complete overlap result, and successful database finalization.

The owner queue reads pending booking rows regardless of call completion, call follow-up, or age. It shows the oldest 100 and the total count. Read failures are shown as unavailable, never as evidence of no booking. The owner action resolves the authenticated tenant and owner role before privileged access, audits intent before reconciliation, and performs a bounded check under the 45-second database lease. Recovery never inserts or deletes provider events. Successful recovery updates booking and call summary atomically; promised callbacks remain visible until handled.

Per pass: one lease attempt, at most one marker lookup and one overlap lookup, plus bounded database writes/audit calls. Google and database adapters retain their existing eight-second request timeouts. This is a bound on operations, not a new whole-request SLA. No background worker or scheduled job was activated.

## 6. Actual validation

Final relevant test command, with an explicitly disposable local PostgreSQL URL and an otherwise empty credential environment:

```sh
env -i PATH="$PATH" HOME="$HOME" NO_COLOR=1 \
  DATABASE_URL=postgresql://postgres@127.0.0.1:55481/h001_reviewed \
  ./node_modules/.bin/vitest run lib/revenueDesk lib/leads/intake lib/agents lib/events --reporter=default
```

**738 tests passed across 42 files; zero failures and zero skips.** Final test duration: 3.03 seconds. Relevant breakdown: Revenue Desk domain/webhook 131, Revenue Desk real PostgreSQL 25, Google adapter 6, owner recovery action 6; canonical intake includes 39 service tests and 10 real PostgreSQL tests, plus route/store/legacy regressions. The remainder covers agent authorization/governance and event contracts/persistence.

The disposable PostgreSQL 17.11 instance applied the repository's scaffold and migrations 001–028 from scratch. It contained synthetic test data only and was removed after validation. This does not validate M006's hosted schema state or its recovery variant.

Full test/check/migration receipts, the reviewed patch and SHA-256 file manifest are retained locally in `/Users/vr/.codex/visualizations/2026/10/15/01a14099-9606-7e70-9ab9-1725d46425d8/h001-evidence/`.

Required checks: `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed on the reviewed source. The build ran without provider/database credentials and with Next telemetry disabled. Existing tooling warnings concern `next lint` deprecation and inferred workspace root/multiple lockfiles; they are not lint errors. Expected fault-injection logs are retained in the test receipt.

Earlier intermediate failures exposed outdated expectations for automatic retry after lease expiry; those were corrected to assert no new write. The earlier credential-free run skipped database suites; the final 738-test run executed them against the disposable database. No skipped suite is counted as passed.

Regressions cover model-only/absent/unavailable confirmation, exact confirmation binding, corrected fields, conflicting revisions, lost persistence acknowledgements, old tool replays, partial transaction rollback, tenant isolation, RLS/RPC privilege checks, explicit transfer reasons, signed duplicate notifications, no-route promises, terminal contradictions, delayed writes, expired leases, stale workers, cleanup timeouts, incomplete provider evidence, and interrupted owner follow-up. Zero unauthorized writes, false confirmations, duplicate confirmed bookings or cross-tenant disclosures were observed in these tests; this is not a production guarantee.

## 7. Security impact

HMAC verification, signature freshness, tenant resolution from the configured provider number, bounded tool input validation, agent permission evaluation, saved-assistant overrides and no-send behavior remain intact. New correction RPC execution is revoked from PUBLIC, anon and authenticated roles; only service role/postgres may execute it. Receipts have tenant-read RLS and no member write policy. New owner recovery writes require an authenticated owner and tenant-filtered lookup. Its input cannot select a tenant, calendar, provider destination or event ID.

No credentials, transcripts, recordings or unrelated customer data were read or exported. No email/SMS/outbound call path was added. Google event writes still specify `sendUpdates:none`. New audit payloads use the existing privacy allowlist.

## 8. Migration proposal and dependencies

`028_revenue_desk_hardening.sql` is a **proposal**, tested locally only. It depends on the reconciled 001–027 schema, canonical provenance, composite tenant keys, service-role privileges and the lease RPC. It adds call revision/digest/finality fields, receipt storage, expanded transfer outcomes and a booking lease token; it replaces the lease implementation and adds transaction/transition functions. DDL is wrapped in a transaction and requests PostgREST schema-cache reload.

A preflight stops migration if legacy failed bookings have `PROVIDER_ERROR` or `CONFLICT_CLEANUP_FAILED`: the old code could have finalized an uncertain write. Those rows need independent review, not automatic reopening of unique guards.

Do not deploy this application patch before its schema is approved and available. After M006 finishes, reconcile migration numbering, constraint names, actual Preview schema and any concurrent branch changes. Plan coordinated activation; do not run old unfenced booking writers concurrently with the new recovery path. No hosted migration or recovery-file edit occurred here.

## 9. Classic Vapi and GPT-Live compatibility

Both providers use the same backend confirmation refusal, canonical correction transaction and booking recovery rules. Existing five function schemas remain compatible; `callerConfirmed:true` no longer means authorization. No assistant/tool/provider configuration was changed.

The accepted VAPI-READ-001 account findings remain the baseline: GPT-Live UI conversion availability is not verified runtime entitlement; reasoner selection, paid-call behavior and dynamic-transfer delivery remain untested. GPT-Live's documented native Twilio blind transfer does not establish human answer. Existing published server subscriptions do not establish that `transfer-update` is enabled; without it, initiation can remain unobserved and end reasons still map conservatively. No reasoner, provider or pricing assumptions were changed by this engineering mission.

## 10. Unresolved risks

- Autonomous booking remains intentionally unavailable. A trusted consent channel, durable issuance/consumption implementation and its concurrency tests require separate approval and evidence before activation.
- Human answer is never claimed; forwarding may reach voicemail or IVR. No live transfer acceptance test ran.
- Empty or ambiguous recovery evidence can remain unresolved indefinitely. Cleanup cases need an assigned operator, an approved evidence procedure and an operational SLA. There is no blind retry or force-confirm/force-cancel button.
- A restarted call is not linked by phone alone to an earlier attempt. New live writes are blocked, so it cannot create a second automatic booking; a future enabled writer needs independently authorized cross-call recovery before that containment is lifted.
- The exception list displays the oldest 100 and total backlog. Larger operational volumes need a reviewed pagination/triage plan.
- Calendar evidence is a bounded observation, not a distributed transaction with Google or a guarantee against later external calendar edits. No exactly-once provider guarantee is claimed.
- Existing secondary audit emissions remain best-effort; a crash can leave an intent/receipt without a result event. Durable booking/call/receipt state remains authoritative.
- Local PostgreSQL and mocks do not prove hosted PostgREST behavior, Supabase recovery success, account entitlement, saved Vapi delivery, or production readiness.

## 11. Reviewed diff

Manually reviewed the complete changed source, new files and SQL against the fixed baseline. Review covered every new-write entry point, correction validation/ownership/replay behavior, lease fencing and cleanup transitions, provider-read completeness, owner authorization, event privacy, migration ACLs and no-send boundaries.

Review corrections included: fencing the original writer after lease takeover, preserving cleanup intent before deletion, atomic call-summary confirmation, auditable owner recovery, explicit unavailable read evidence, and duplicate ordinary call-end handling. Existing tests that expected unsafe expired-lease writes were replaced with non-final/no-write assertions, not removed. No unrelated source or dependency changes remain. No independent external reviewer or subagent review is claimed.

## 12. Assessment

| Gate | Result |
|---|---|
| Isolation and preservation | PASS |
| Local correction/transfer/reconciliation regressions | PASS |
| Required local typecheck/lint/build | PASS |
| A — fail-closed containment | PASS |
| A — usable autonomous confirmation mechanism | HOLD — trusted source absent |
| Shared local hardening package | CONDITIONAL PASS — schema and operational dependencies remain |
| Hosted integration, live voice, autonomous booking | HOLD |

## 13. Exact next Founder decision

Recommended next authorization:

> APPROVED — H001 local integration preparation only. Commit the reviewed isolated patch, reconcile the then-current Revenue Desk branch and M006 schema evidence read-only, and prepare a coordinated Preview integration/migration plan in a separate integration worktree. Preserve the fail-closed booking gate. Do not alter Claude's worktree. No push, merge, hosted migration, deployment, provider change or paid call is authorized by this decision.

Actual hosted integration subsequently requires explicit approval of the reconciled migration, target Preview environment, source revision, activation/rollback procedure and deployment effects. Consent-channel implementation and controlled live acceptance require their own bounded authorization. No such additional work has begun. This mission stops after local validation and diff review.
