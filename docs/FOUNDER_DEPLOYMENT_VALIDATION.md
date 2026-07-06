# Founder Deployment Validation — 5 Star Plumbing Service

Status date: see git log for last commit date. This document is the single
source of truth for whether the Founder Deployment sprint (multi-tenant + RLS,
Missed Call Recovery, Estimate Follow-up, landing page intake, dashboard
analytics) is actually safe to run 5 Star Plumbing Service's daily operations
on. It records what was verified by automated/DB inspection versus what still
requires the founder to execute live.

**Production app domain: `https://aibackoffice.app`** — confirmed
live (Step 1 resolved). Fetched directly and matches this repo's own landing
page (`app/page.tsx`: "Turn missed calls into booked jobs..."). The Vercel
project hosting it is under a different Vercel account/team than the one
connected to this session, so env vars there cannot be read or listed via
tooling here — verification of that project's env vars must happen through
the Vercel dashboard directly (see §4A).

## 0. Founder Login Root Cause (RESOLVED)

Login previously failed in production with an opaque `"{}"` error on every
attempt. Root cause, confirmed via Supabase's own Auth (GoTrue) service logs
(`get_logs`, service `auth`):

> `sql: Scan error on column index 8, name "email_change": converting NULL
> to string is unsupported` — on both `POST /token` (password login) and
> `GET /admin/users` (Admin API), status `500`.

The founder's `auth.users` row was created via a manual SQL `INSERT` earlier
in this sprint (necessary since this project had zero auth users at the
time). That insert set `confirmation_token`/`recovery_token` to `''` but left
`email_change` and `email_change_token_new` as `NULL`. GoTrue's Go SQL scanner
expects those columns as non-nullable strings and crashes with a 500 on
*any* request touching that user row — which is why the error was identical
regardless of correct credentials, correct tenant/membership data, correct
env vars, or the concurrent (and otherwise unrelated) Supabase `us-east-1`
platform incident that was investigated and ruled out in parallel.

**Fix applied** (data-only, no code changes):
```sql
update auth.users
set email_change = '', email_change_token_new = ''
where email = '5starplumbing05@gmail.com';
```

**Verified**: Auth logs show the next `GET /admin/users` returning a clean
`200` immediately after the fix (previously an unbroken string of `500`s).
Founder confirmed live login + dashboard load in production immediately
after.

**Standing risk**: any *future* manually-seeded `auth.users` row must set
every nullable-but-treated-as-non-null GoTrue text column
(`email_change`, `email_change_token_new`, `email_change_token_current`,
`phone_change`, `phone_change_token`, `confirmation_token`, `recovery_token`,
`reauthentication_token`) to `''`, not `NULL`, or this exact failure mode
recurs. Prefer Supabase's Admin API / dashboard "Invite user" flow over raw
SQL insert for any future user creation to avoid this class of bug entirely.

## 1. Environment Variables Required

| Variable | Purpose | Status (this check) |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase client (browser + server) | Documented in `.env.example`; **not verified live** — no local `.env.local` present in this environment |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase client (browser + server) | Documented; not verified live |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side data access (bypasses RLS — see [[06_DATABASE_PRINCIPLES]]) | Documented; not verified live |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SHEET_ID` | Legacy Google Sheets fallback data source | Documented; optional now that Supabase is the tenant-scoped source of truth |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Missed Call Recovery + Estimate Follow-up SMS sending | Documented in `.env.example`; **not confirmed set anywhere** — see Blocker B1 |
| `OWNER_ALERT_PHONE` | Legacy emergency-alert endpoint (`/api/sms/emergency-alert`) | Documented; optional, separate from the two MVP modules |
| `CRON_SECRET` | Authenticates Vercel Cron → `/api/modules/estimate-followup/trigger` | Documented in `.env.example` and referenced in `vercel.json`; **not confirmed set anywhere** — see Blocker B2 |

No secret values were read, printed, or exposed as part of this validation — only variable *names* and whether the code paths that consume them are present and correctly gated (i.e., they fail closed/skip rather than crash when unset, per the existing `lib/sms/twilio.ts` pattern).

## 2. Supabase Project Confirmation

- Project: **AIBACKOFFICE** (`yohfpsaemgibarlgodmh`), region `us-east-1`, status **ACTIVE_HEALTHY** as of this check.
- Tenant confirmed present:

  | tenant_id | name | status | founder email | leads | missed-call history | estimate sequences |
  |---|---|---|---|---|---|---|
  | `32e5bfa9-6d3b-4801-aca5-1a42d818ae67` | 5 Star Plumbing Service | active | `5starplumbing05@gmail.com` | 0 | 0 | 0 |

- RLS policies confirmed present on every tenant-scoped table (`tenants`, `tenant_memberships`, `leads`, `missed_call_recovery_settings`, `missed_call_recovery_history`, `estimate_followup_settings`, `estimate_followup_sequences`, `estimate_followup_history`). `platform_prospects` intentionally has RLS enabled with **no** policies — service-role only by design.
- Zero rows of real activity exist yet in any history/sequence table. This is expected — nothing has been exercised against a live call, estimate, or SMS reply yet.
- `missed_call_recovery_settings.business_phone` is **`NULL`** for the 5 Star Plumbing tenant — this is a hard blocker for live Missed Call Recovery testing (see Blocker B3).

## 3. Twilio Setup Steps (for the founder to perform)

1. Confirm or purchase the Twilio phone number 5 Star Plumbing will use as its business line.
2. In the Twilio Console, on that number's configuration page, set:
   - **Voice → A Call Comes In**: point at your call-forwarding/IVR flow, and set **Voice → Call Status Changes** (StatusCallback) to `https://aibackoffice.app/api/modules/missed-call-recovery/trigger`, method `POST`. Twilio must be configured to fire the status callback on `no-answer`, `busy`, and `failed` — those are the three statuses the trigger route checks.
   - **Messaging → A Message Comes In**: `https://aibackoffice.app/api/modules/estimate-followup/trigger`, method `POST`. This is the same endpoint used for the Day 1/3/7 cron scan (`GET`, separately authenticated) — inbound SMS uses `POST` with Twilio's standard form-encoded webhook body.
3. Set the environment variables `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` in the deployment environment (see §4).
4. Update the 5 Star Plumbing tenant's Missed Call Recovery settings (`business_phone`) to match the Twilio number — via `PUT /api/modules/missed-call-recovery/settings` once logged in, or directly in Supabase.

## 4. Vercel Deployment Steps

**Step 1 — RESOLVED.** Production app confirmed live at
**`https://aibackoffice.app`**. Fetched directly and confirmed it
serves this repo's actual landing page (`app/page.tsx`), not a placeholder.
The hosting Vercel project is under a **different Vercel account/team** than
the one connected to this tooling session (the connected account
`alfosoalf5-4619s-projects` only shows `invoice-pilot-pro`,
`agios-business-intelligence`, `venture-studio-website`, and others — not this
project). This is expected, not a problem: it means **env var verification
for this project must happen manually through the Vercel dashboard** rather
than through the Vercel MCP tooling available in this session. See §4A for
the walkthrough.

### 4A. Verifying env vars in the Vercel dashboard (no secrets exposed)

1. Log into **vercel.com** with whichever account owns `ai-backoffice-v1`.
2. Open the project, then **Settings → Environment Variables**.
3. For each variable below, confirm a row exists for the **Production**
   environment (Preview/Development optional but recommended to match). Do
   **not** click "reveal" and paste the value back to me — I only need a
   yes/no per variable, never the value itself:

   - [ ] `NEXT_PUBLIC_SUPABASE_URL`
   - [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - [ ] `SUPABASE_SERVICE_ROLE_KEY`
   - [ ] `TWILIO_ACCOUNT_SID`
   - [ ] `TWILIO_AUTH_TOKEN`
   - [ ] `TWILIO_PHONE_NUMBER`
   - [ ] `CRON_SECRET`

4. Report back which of the seven are **present** and which are **missing**
   — that's all I need to update this document and unblock the next step.
5. If any are missing: add them (values only known to you/the founder), save,
   then trigger a redeploy (Vercel does not hot-reload env vars into an
   already-running deployment).
6. **Root cause of the post-push production 500s: Vercel Hobby plan rejects
   cron schedules more frequent than once per day.** `vercel.json` originally
   scheduled the Estimate Follow-up scan hourly (`0 * * * *`), which Vercel's
   Hobby tier does not allow — this caused the deployment itself to fail,
   which is why `/`, `/auth/login`, and `/dashboard` all returned bare 500s
   after commit `2a59ed5` was pushed (nothing to do with the middleware or
   login fixes in that same commit — those were correct).
   **Fixed:** the cron schedule is now `0 9 * * *` (once daily, 9am UTC),
   which is Hobby-plan compatible.
   **TODO (future):** if Estimate Follow-up needs sub-daily precision (e.g.
   hourly scanning so a Day 1 message goes out within an hour of becoming due
   rather than up to ~24h late), upgrade the Vercel project to a Pro plan and
   change the schedule back to `0 * * * *` (or a finer interval). Not required
   for Founder Deployment MVP scope — a daily scan still satisfies "Day 1 / 3
   / 7" sequencing correctness, just with coarser same-day timing.

## 5. Manual Test Checklist, Expected vs. Actual Results

| # | Check | Expected | Actual (this pass) | Status |
|---|---|---|---|---|
| 1 | Founder login works | Login with `5starplumbing05@gmail.com` succeeds, session persists | **Confirmed live** — root cause (NULL `email_change`/`email_change_token_new` in `auth.users`, see §0) fixed via SQL update; founder confirmed successful login + dashboard load in production | ✅ Verified live |
| 2 | Tenant scoping works | Every query filters by `tenant_id`; a user from another tenant cannot see 5 Star's data | Code inspection confirms `lib/leads/supabase.ts`, `lib/leads/repository.ts`, all leads pages/API routes, and both module services filter by `tenant_id` explicitly (required because the app uses the service-role key, which bypasses RLS — see [[06_DATABASE_PRINCIPLES]]). Only one tenant exists currently, so cross-tenant isolation itself isn't yet exercised live — code path is sound but there's no second tenant to prove leakage can't happen | ✅ Verified by code inspection; ⏳ true cross-tenant test needs a 2nd tenant |
| 3 | Dashboard loads real tenant data | `/dashboard` shows 5 Star's leads + module analytics, not another tenant's | `getTenantContext()` correctly resolves the founder's single `tenant_memberships` row to "5 Star Plumbing Service" (confirmed via direct SQL join); DB currently has 0 leads for this tenant so the dashboard correctly shows zeros, not another tenant's data | ✅ Verified by DB inspection + live login |
| 4 | Twilio env vars documented and checked | All required vars present in `.env.example`; code fails closed (skips, doesn't crash) when unset | Confirmed in `.env.example`; `lib/sms/twilio.ts` `getTwilioBaseEnv()`/`getTwilioEnv()` return `configured: false` and calling code logs + skips rather than throwing. **Founder confirmed all 4 vars (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `CRON_SECRET`) present on the Production Vercel environment** | ✅ Verified |
| 5 | Missed Call Recovery can receive a real webhook | Twilio StatusCallback POST to `https://aibackoffice.app/api/modules/missed-call-recovery/trigger` resolves tenant and fires | Route logic confirmed correct; public URL live (B0 resolved); Twilio env vars confirmed present (B1 resolved); `business_phone` now set to `+17868087223` (B3 resolved). **Not yet fired with a real call** — needs the Twilio Console webhook wiring in §3 below | ⏳ Ready for live test |
| 6 | A missed call creates/updates a lead | New lead row with `source = 'missed-call-recovery'`, `tenant_id` set | Code confirmed in `executeMissedCallRecovery()`; not exercised live | ⏳ Pending founder (blocked on #5) |
| 7 | Recovery SMS sends successfully | Twilio SMS delivered to caller | `sendSms()` implementation confirmed; not exercised live (no Twilio creds confirmed set) | ⏳ Pending founder |
| 8 | Recovery history is recorded | Row in `missed_call_recovery_history` | Table + insert logic confirmed present; 0 rows currently (expected, nothing fired yet) | ⏳ Pending founder |
| 9 | Recovery analytics update | `/api/modules/missed-call-recovery/analytics` reflects new history | Logic confirmed derives directly from history table; will update correctly once #8 has data | ✅ Logic verified; ⏳ live data pending |
| 10 | Lead can be marked Estimate Sent | `PUT /api/leads/[id]` with `status: "Estimate Sent"` succeeds | Confirmed working code path (existing, unchanged from Sprint 1 lead editing) | ✅ Verified by code inspection |
| 11 | Estimate Follow-up enrollment created automatically | `estimate_followup_sequences` row created on the status change | `enrollLeadInFollowup()` is called from the leads PUT route when `payload.status === "Estimate Sent"`; confirmed wired in `app/api/leads/[id]/route.ts` | ✅ Verified by code inspection; ⏳ live confirmation pending (needs a real lead to test against — 0 leads currently exist for this tenant) |
| 12 | Day 1/3/7 sequence logic is correct | Correct due-date math, correct template rendering, correct step ordering | Reviewed `lib/modules/estimateFollowup/service.ts`: due dates computed as `sentAt + 1/3/7 days`; `processSequence()` finds the earliest unsent step whose due date has passed; templates render `{{customer_name}}` / `{{service_type}}` | ✅ Verified by code inspection; ⏳ live timing confirmation pending (needs the cron actually running against a live deployment) |
| 13 | Inbound SMS reply stops the sequence | Sequence status → `replied`, no further sends | `recordReplyForPhone()` matches inbound `From` to the tenant's most recent lead by phone, then sets the active sequence to `replied` if `stop_on_reply` is true (default) | ✅ Verified by code inspection; ⏳ live confirmation pending |
| 14 | Automation history is recorded | Every send/reply/stop event lands in `estimate_followup_history` | Confirmed — `writeHistory()` is called from every branch of `processSequence()` and `recordReplyForPhone()` | ✅ Verified by code inspection |
| 15 | Automation analytics update | `/api/modules/estimate-followup/analytics` reflects sequence status counts | Confirmed derives from `estimate_followup_sequences.status`; will be correct once live sequences exist | ✅ Logic verified; ⏳ live data pending |
| 16 | Landing page intake endpoint accepts a prospect payload | `POST /api/prospects/intake` with `businessName` (+ optional fields) returns `{ ok: true, prospectId }` | Route confirmed present and validates `businessName` is required; **the actual landing page has not been wired to call it** — that form lives in a separate repo/deployment not present in this working directory | ⚠️ Endpoint ready, integration not done |
| 17 | Prospect appears in `/prospects` | Submitted prospect visible in the internal `/prospects` page | `listProspects()` reads directly from `platform_prospects`; page is wired correctly; 0 rows currently (expected — nothing submitted yet) | ✅ Verified by code inspection |
| 18 | Build still passes | `next build` completes with no errors | **Confirmed** — ran locally, all 24 routes compiled successfully | ✅ Pass |
| 19 | Typecheck still passes | `tsc --noEmit` completes with no errors | **Confirmed** — ran locally, zero errors | ✅ Pass |
| 20 | Failed validations documented as blockers | — | See §6 below | ✅ Done (this document) |

## 6. Blockers

| ID | Blocker | Severity | Owner | Unblocks |
|---|---|---|---|---|
| B0 | ~~No Vercel project found under the connected account~~ — **RESOLVED**. Confirmed live at `https://aibackoffice.app` under a different Vercel account/team than the one connected to this tooling session | Resolved | — | #1, #5–9, #12–13, #16 |
| B1 | ~~Twilio credentials not confirmed set~~ — **RESOLVED**. Founder confirmed `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` all present on the Production Vercel environment | Resolved | — | #5, #7 |
| B2 | ~~`CRON_SECRET` not confirmed set~~ — **RESOLVED**. Confirmed present alongside the other 3 Twilio vars | Resolved | — | #12 |
| B3 | ~~`missed_call_recovery_settings.business_phone` is `NULL`~~ — **RESOLVED**. Set to `+17868087223` (the confirmed `TWILIO_PHONE_NUMBER` value) via direct SQL update | Resolved | — | #5, #6 |
| B8 | Founder login was blocked by corrupt `auth.users` data (NULL `email_change`/`email_change_token_new`), not a code or config bug — **RESOLVED**, see §0 for full root cause and fix | Resolved | — | #1 |
| B4 | No real leads exist yet for the tenant — Estimate Follow-up enrollment (#11) and sequence timing (#12) cannot be exercised end-to-end until at least one real lead is marked "Estimate Sent" | Medium | Founder | #11, #12, #13 |
| B5 | Landing page form (separate repo, `aibackoffice-landing.vercel.app`) has not been updated to POST to `/api/prospects/intake` | Medium | Founder / whoever owns that repo | #16 |
| B6 | ~~No `npm run typecheck` script~~ — **RESOLVED**. Added `"typecheck": "tsc --noEmit"` to `package.json` | Resolved | — | tooling convenience only |
| B7 | Vercel Hobby plan rejects cron schedules more frequent than once/day — the original hourly Estimate Follow-up scan schedule (`0 * * * *`) blocked deployment of commit `2a59ed5`, producing the site-wide 500s. **Fixed**: schedule changed to `0 9 * * *` (daily). See §4A item 6 for the future Pro-upgrade TODO if sub-daily scanning is needed | Resolved | — | #12 (Day 1/3/7 timing precision) |

## 7. Fixes Applied During This Validation Pass

- Fixed founder login root cause: `UPDATE auth.users SET email_change = '', email_change_token_new = '' WHERE email = '5starplumbing05@gmail.com'` (see §0). Data-only fix, no code changes.
- Set `missed_call_recovery_settings.business_phone = '+17868087223'` for the 5 Star Plumbing tenant, matching the confirmed `TWILIO_PHONE_NUMBER` value.
- Confirmed (via founder) all 4 Twilio/cron env vars present on Production Vercel.

## 8. Twilio Webhook URLs to Configure

Exact URLs for the Twilio Console, for the number `+17868087223`:

| Purpose | URL | Method | Where in Twilio Console |
|---|---|---|---|
| Missed call recovery (voice status callback) | `https://aibackoffice.app/api/modules/missed-call-recovery/trigger` | `POST` | Phone Numbers → Manage → Active Numbers → `+17868087223` → **Voice Configuration → Call Status Changes** |
| Estimate follow-up reply detection (inbound SMS) | `https://aibackoffice.app/api/modules/estimate-followup/trigger` | `POST` | Phone Numbers → Manage → Active Numbers → `+17868087223` → **Messaging Configuration → A Message Comes In** |

Notes:
- The Voice Status Callback must be configured to fire on **all** relevant statuses — specifically `no-answer`, `busy`, and `failed`. These are the exact three the trigger route checks; anything else is ignored (returns `{ok: true, fired: false, reason: "not-a-missed-call"}`).
- The Estimate Follow-up trigger endpoint also handles the daily cron scan via `GET` with `Authorization: Bearer $CRON_SECRET` (Vercel Cron calls this automatically per `vercel.json` — no manual Twilio Console action needed for that half).
- No separate voice webhook ("A Call Comes In") change is required for this test — that's whatever call-forwarding/IVR flow already exists on this number; only the **Status Callback** needs to point at AI BackOffice.

## 9. Live Missed-Call Test Checklist

Run in this exact order. Each step's evidence should be pulled from Supabase directly (`get_logs` service `auth`/`api`, or `execute_sql` against `missed_call_recovery_history`) rather than assumed from the UI alone.

1. **Twilio Console**: set the Voice Status Callback URL on `+17868087223` per §8, method `POST`, statuses `no-answer`/`busy`/`failed` (or "all" if that's the only option offered).
2. **Place a real test call** to `+17868087223` from a phone you control, and let it go unanswered (or busy it out) to trigger `no-answer`/`busy`.
3. **Check `missed_call_recovery_history`** for a new row: `select * from missed_call_recovery_history order by created_at desc limit 1;` — confirm `tenant_id` matches 5 Star Plumbing, `caller_phone` matches your test number, `status` is `recovered` (not `failed`/`skipped`).
4. **Confirm the recovery SMS arrived** on the phone you called from.
5. **Check `/lead-inbox`** in the app (logged in as founder) — confirm a new lead appears with `source: missed-call-recovery` and the caller's phone number.
6. **Check `/api/modules/missed-call-recovery/analytics`** (authenticated) — confirm `totalMissedCalls` and `recovered` incremented by 1.
7. If step 3 shows `status: failed` or no row at all, pull fresh Twilio Console **Debugger** logs for that call SID, and Supabase `get_logs` for service `api` (not `auth`) around the same timestamp — that will show whether the request reached AI BackOffice at all versus failing inside it.

Do **not** proceed to Estimate Follow-up or landing-page-intake live testing until this checklist passes end-to-end — Missed Call Recovery was the first MVP module in the Founder Deployment priority order and should be proven live before moving on.

## 10. Final Go/No-Go Verdict

**Founder login: GO — confirmed live and working.** Root cause identified with hard evidence (Supabase Auth service logs), fixed with a minimal data-only repair, verified via both a clean `200` in the logs and an actual successful login.

**Missed Call Recovery: GO for live testing, not yet fired.** All blockers that were blocking this (B0, B1, B2, B3) are now resolved — deployment live, Twilio env vars present, business_phone set. What remains is purely the Twilio Console webhook configuration in §8 and running the checklist in §9. This is the very next action.

**Estimate Follow-up: still needs a real lead.** Enrollment/sequencing logic is verified by code inspection only (B4 — no real leads exist for this tenant yet). Once Missed Call Recovery is live and producing real leads, mark one "Estimate Sent" and re-run rows #10-15 in §5 as live checks.

**Landing page intake: endpoint ready, integration pending.** `/api/prospects/intake` works; the actual landing page form (separate repo) still needs to be pointed at it (B5) — out of scope for this repo's validation.

Do not consider this sprint complete until every row in §5 reads ✅ with a live (not code-inspected) result.
