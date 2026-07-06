# Founder Deployment Validation — 5 Star Plumbing Service

Status date: see git log for last commit date. This document is the single
source of truth for whether the Founder Deployment sprint (multi-tenant + RLS,
Missed Call Recovery, Estimate Follow-up, landing page intake, dashboard
analytics) is actually safe to run 5 Star Plumbing Service's daily operations
on. It records what was verified by automated/DB inspection versus what still
requires the founder to execute live.

**Production app domain: `https://ai-backoffice-v1.vercel.app`** — confirmed
live (Step 1 resolved). Fetched directly and matches this repo's own landing
page (`app/page.tsx`: "Turn missed calls into booked jobs..."). The Vercel
project hosting it is under a different Vercel account/team than the one
connected to this session, so env vars there cannot be read or listed via
tooling here — verification of that project's env vars must happen through
the Vercel dashboard directly (see §4A).

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
   - **Voice → A Call Comes In**: point at your call-forwarding/IVR flow, and set **Voice → Call Status Changes** (StatusCallback) to `https://ai-backoffice-v1.vercel.app/api/modules/missed-call-recovery/trigger`, method `POST`. Twilio must be configured to fire the status callback on `no-answer`, `busy`, and `failed` — those are the three statuses the trigger route checks.
   - **Messaging → A Message Comes In**: `https://ai-backoffice-v1.vercel.app/api/modules/estimate-followup/trigger`, method `POST`. This is the same endpoint used for the Day 1/3/7 cron scan (`GET`, separately authenticated) — inbound SMS uses `POST` with Twilio's standard form-encoded webhook body.
3. Set the environment variables `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` in the deployment environment (see §4).
4. Update the 5 Star Plumbing tenant's Missed Call Recovery settings (`business_phone`) to match the Twilio number — via `PUT /api/modules/missed-call-recovery/settings` once logged in, or directly in Supabase.

## 4. Vercel Deployment Steps

**Step 1 — RESOLVED.** Production app confirmed live at
**`https://ai-backoffice-v1.vercel.app`**. Fetched directly and confirmed it
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
6. Confirm the project's plan supports **Vercel Cron** (Hobby plans historically
   limited cron frequency/count — Pro removes those limits). This matters
   because `vercel.json` schedules the Estimate Follow-up scan hourly.

## 5. Manual Test Checklist, Expected vs. Actual Results

| # | Check | Expected | Actual (this pass) | Status |
|---|---|---|---|---|
| 1 | Founder login works | Login with `5starplumbing05@gmail.com` succeeds, session persists | Auth user + password confirmed created in Supabase; **not exercised through the live login form** (requires a reachable deployment) | ⏳ Pending founder |
| 2 | Tenant scoping works | Every query filters by `tenant_id`; a user from another tenant cannot see 5 Star's data | Code inspection confirms `lib/leads/supabase.ts`, `lib/leads/repository.ts`, all leads pages/API routes, and both module services filter by `tenant_id` explicitly (required because the app uses the service-role key, which bypasses RLS — see [[06_DATABASE_PRINCIPLES]]) | ✅ Verified by code inspection |
| 3 | Dashboard loads real tenant data | `/dashboard` shows 5 Star's leads + module analytics, not another tenant's | `getTenantContext()` resolves via `tenant_memberships`; dashboard queries are tenant-scoped; DB currently has 0 leads for this tenant so the dashboard will correctly show zeros | ✅ Verified by code + DB inspection; ⏳ visual confirmation pending founder login |
| 4 | Twilio env vars documented and checked | All required vars present in `.env.example`; code fails closed (skips, doesn't crash) when unset | Confirmed in `.env.example`; `lib/sms/twilio.ts` `getTwilioBaseEnv()`/`getTwilioEnv()` return `configured: false` and calling code logs + skips rather than throwing | ✅ Verified |
| 5 | Missed Call Recovery can receive a real webhook | Twilio StatusCallback POST to `https://ai-backoffice-v1.vercel.app/api/modules/missed-call-recovery/trigger` resolves tenant and fires | Route logic confirmed correct (checks `CallStatus` in `no-answer/busy/failed`, resolves tenant via `To` number); public URL now confirmed live (B0 resolved), but **cannot fire for real yet** — `business_phone` still unset (Blocker B3) and Twilio env vars not yet confirmed on this Vercel project (Blocker B1) | ❌ Blocked |
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
| B0 | ~~No Vercel project found under the connected account~~ — **RESOLVED**. Confirmed live at `https://ai-backoffice-v1.vercel.app` under a different Vercel account/team than the one connected to this tooling session | Resolved | — | #1, #5–9, #12–13, #16 |
| B1 | Twilio credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`) not yet confirmed set on the `ai-backoffice-v1` Vercel project — cannot be checked via tooling since it's on a different account; see §4A for the manual dashboard walkthrough | **Critical** | Founder | #5, #7 |
| B2 | `CRON_SECRET` not yet confirmed set on the `ai-backoffice-v1` Vercel project — without it the Day 1/3/7 scheduled scan (`GET` on the trigger route) will reject with 401 even though the deployment itself is live; see §4A | High | Founder | #12 |
| B3 | 5 Star Plumbing tenant's `missed_call_recovery_settings.business_phone` is `NULL` — the trigger route cannot resolve which tenant a missed call belongs to until this is set to the real Twilio number | **Critical** | Founder (via Settings UI or direct DB update once the Twilio number is chosen) | #5, #6 |
| B4 | No real leads exist yet for the tenant — Estimate Follow-up enrollment (#11) and sequence timing (#12) cannot be exercised end-to-end until at least one real lead is marked "Estimate Sent" | Medium | Founder | #11, #12, #13 |
| B5 | Landing page form (separate repo, `aibackoffice-landing.vercel.app`) has not been updated to POST to `/api/prospects/intake` | Medium | Founder / whoever owns that repo | #16 |
| B6 | No `npm run typecheck` script exists in `package.json` — typecheck was run via `npx tsc --noEmit` directly. Minor, but worth adding per docs/constitution/09_DEVELOPMENT_STANDARDS.md | Low | Engineering | tooling convenience only |

## 7. Fixes Applied During This Validation Pass

None — per instructions, this pass was read-only/inspection-only (no destructive database changes, no secret exposure). No code or schema changes were made. If any of the above blockers are resolved (Twilio configured, Vercel project confirmed, business_phone set), re-run this checklist and update the Actual Results column rather than assuming it's fixed.

## 8. Final Go/No-Go Verdict

**NO-GO for live production traffic (unchanged).** The foundation is sound — multi-tenant isolation, RLS, module architecture, and business logic all check out under static/code/DB inspection, and build + typecheck both pass cleanly. The deployment itself is now confirmed live (B0 resolved), but two critical blockers remain (B1, B3): Twilio credentials are not yet confirmed set on the `ai-backoffice-v1` Vercel project, and no business phone number is configured for the tenant. The MVP automation modules **still cannot fire for a single real event** until those clear.

**GO for founder-guided live validation**, in this exact order (see step-by-step guide below): verify env vars in the Vercel dashboard (§4A) → set business_phone → configure Twilio webhooks → send a real test SMS → place a real test missed call → mark a real lead as Estimate Sent → wait for/force the Day 1 send → reply to stop the sequence → submit a test prospect.

Do not consider this sprint complete until every row in §5 reads ✅ with a live (not code-inspected) result.
