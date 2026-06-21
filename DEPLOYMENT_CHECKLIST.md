# Sprint 1 Pilot Deployment Checklist

**Project:** AI BackOffice v1 — 5 Star Plumbing  
**Stack:** Next.js 14 · Supabase (auth + database) · Google Sheets (read fallback) · Vercel  
**Sprint 1 scope:** Login/logout, protected routes, lead inbox, lead detail editing, status persistence

Work through each section in order. Check off items as you go. Do not skip ahead.

---

## 1. Supabase Setup

### 1a. Create Project

- [ ] Log in to [supabase.com](https://supabase.com) and create a new project
- [ ] Choose a region close to your users (US East or US West)
- [ ] Save the database password somewhere secure — you will not see it again
- [ ] Wait for the project to finish provisioning (~2 min)

### 1b. Run the Migration

Navigate to **SQL Editor** in your Supabase project and run the full contents of:

```
db/migrations/001_create_leads_table.sql
```

This creates the `public.leads` table with all required columns and indexes. You can paste the file directly into the SQL editor and click **Run**.

Verify the table was created:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'leads'
ORDER BY ordinal_position;
```

Expected columns (in any order): `id`, `date`, `customer_name`, `phone`, `email`, `service_address`, `property_type`, `service_type`, `emergency`, `urgency`, `job_description`, `photos_uploaded`, `preferred_appointment_time`, `customer_role`, `lead_source`, `customer_notes`, `status`, `estimate_amount`, `follow_up_date`, `review_request_status`, `internal_notes`, `source`, `created_at`, `updated_at`, `sms_sent_at`

- [ ] Migration ran without errors
- [ ] Table verified in **Table Editor**

### 1c. Collect Supabase Keys

Go to **Project Settings → API**:

- [ ] Copy **Project URL** (`https://<ref>.supabase.co`) → `NEXT_PUBLIC_SUPABASE_URL`
- [ ] Copy **anon / public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- [ ] Copy **service_role** key → `SUPABASE_SERVICE_ROLE_KEY`

> The service role key bypasses Row Level Security. Keep it out of the browser and out of source control. It is used server-side only (`lib/supabase/server.ts`).

### 1d. Configure Auth

Go to **Authentication → URL Configuration**:

- [ ] Set **Site URL** to your Vercel production URL (e.g. `https://ai-backoffice-v1.vercel.app`)
- [ ] Add the same URL to **Redirect URLs**
- [ ] Also add `http://localhost:3000` to Redirect URLs for local testing

Go to **Authentication → Providers**:

- [ ] Confirm **Email** provider is enabled
- [ ] Disable any providers you are not using (Google OAuth, etc.)

---

## 2. Google Sheets Setup

The app reads Google Sheets as a fallback when Supabase has no leads. This requires a Google service account with read access to the sheet.

### 2a. Service Account

- [ ] In [Google Cloud Console](https://console.cloud.google.com), create or select a project
- [ ] Enable the **Google Sheets API** for that project
- [ ] Go to **IAM & Admin → Service Accounts** → Create a service account
- [ ] Generate a JSON key for the service account and download it
- [ ] Copy the `client_email` field → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- [ ] Copy the `private_key` field → `GOOGLE_PRIVATE_KEY`

### 2b. Share the Sheet

- [ ] Open the target Google Sheet
- [ ] Copy the Sheet ID from the URL: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`
  → `GOOGLE_SHEET_ID`
- [ ] Click **Share** → add the service account email with **Viewer** access
- [ ] Confirm the sheet's first tab is named `Form Responses 1`
  (or set `GOOGLE_SHEETS_RANGE` env var to override the default `'Form Responses 1'!A:Z`)

---

## 3. Required Environment Variables

All six variables below are required in production. The app will throw a startup error if any are missing.

| Variable | Where Used | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Auth (browser + server) | From Supabase Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Auth (browser + server) | From Supabase Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Database reads/writes | Server-only. Never expose to browser. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Google Sheets fallback | `client_email` from service account JSON |
| `GOOGLE_PRIVATE_KEY` | Google Sheets fallback | `private_key` from JSON — see note below |
| `GOOGLE_SHEET_ID` | Google Sheets fallback | From the sheet URL |

**`GOOGLE_PRIVATE_KEY` on Vercel:** Paste the key with real newlines in the Vercel env var UI (not `\n` literals). The raw value from the JSON file contains literal `\n` escape sequences — the app calls `.replace(/\\n/g, '\n')` at runtime, so both forms work, but the key must be the full block including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`.

Optional overrides (defaults shown):

| Variable | Default |
|---|---|
| `GOOGLE_SHEETS_RANGE` | `'Form Responses 1'!A:Z` |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Falls back to `GOOGLE_SHEET_ID` |

---

## 4. Test User Creation

The app uses Supabase email/password auth. There is no self-registration UI — users must be created manually.

- [ ] In Supabase → **Authentication → Users** → **Add user**
- [ ] Enter the pilot user's email and a strong password
- [ ] Confirm **Auto Confirm User** is checked (skips email verification for the pilot)
- [ ] Share credentials securely with the pilot user (do not send in plain text over email)
- [ ] Create a second admin/backup account for yourself

> For the pilot, one shared account is fine. Do not create multi-user workflows until Sprint 2.

---

## 5. Vercel Setup

### 5a. Import Project

- [ ] Go to [vercel.com](https://vercel.com) → **New Project** → Import from GitHub
- [ ] Select the `ai-backoffice-v1` repository
- [ ] Framework preset: **Next.js** (auto-detected)
- [ ] Build command: `npm run build` (default)
- [ ] Output directory: `.next` (default)
- [ ] Install command: `npm install` (default)

### 5b. Set Environment Variables

In **Project Settings → Environment Variables**, add all six required variables from Section 3.

- [ ] `NEXT_PUBLIC_SUPABASE_URL` — Production, Preview, Development
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Production, Preview, Development
- [ ] `SUPABASE_SERVICE_ROLE_KEY` — Production only (or Production + Preview)
- [ ] `GOOGLE_SERVICE_ACCOUNT_EMAIL` — Production, Preview, Development
- [ ] `GOOGLE_PRIVATE_KEY` — Production only (paste with real newlines)
- [ ] `GOOGLE_SHEET_ID` — Production, Preview, Development

### 5c. Deploy

- [ ] Click **Deploy**
- [ ] Wait for build to complete — build passes locally with `npm run build` so no surprises expected
- [ ] Note the assigned production URL (e.g. `https://ai-backoffice-v1.vercel.app`)
- [ ] Update Supabase → Authentication → Site URL and Redirect URLs with this production URL (Section 1d)

### 5d. Local Verification (Before Smoke Testing)

Create `.env.local` in the project root with all six variables and confirm the dev build works:

```bash
npm run dev
```

- [ ] Dev server starts on `http://localhost:3000`
- [ ] No missing env var errors in the terminal

---

## 6. Smoke Test Checklist

Run these tests against the production Vercel URL after deployment. Each item must pass before handing the pilot to the customer.

### Auth

- [ ] **Unauthenticated redirect:** Visit `/dashboard` without logging in → should redirect to `/auth/login?redirectTo=%2Fdashboard`
- [ ] **Login:** Enter valid credentials on `/auth/login` → should redirect to `/dashboard`
- [ ] **Already-logged-in redirect:** While logged in, visit `/auth/login` → should redirect to `/dashboard`
- [ ] **Logout:** Navigate to `/auth/logout` → "Signing you out..." → redirected to `/auth/login`
- [ ] **Post-logout protection:** After logout, visit `/lead-inbox` → redirected to `/auth/login`

### Dashboard

- [ ] `/dashboard` loads without error
- [ ] Metrics cards render (Total Leads, New Leads, etc.)
- [ ] Data source label reads either "Supabase" or "Live Google Sheet" (not "Mock Fallback")

### Lead Inbox

- [ ] `/lead-inbox` loads and shows leads
- [ ] Emergency leads (🚨) appear at the top of the list
- [ ] Inline status dropdown renders on each card
- [ ] Change a status via the dropdown → badge updates immediately (optimistic)
- [ ] Reload the page → status change persisted (visible in the card)
- [ ] Clicking the card body (not the dropdown) navigates to the lead detail page

### Lead Detail

- [ ] `/leads/[id]` loads for any lead in the inbox
- [ ] "← Lead Inbox" back-link works
- [ ] **Update Lead** form shows current status, estimate, follow-up date, and internal notes
- [ ] Change the status, estimate, follow-up date, and add a note → click **Save Changes**
- [ ] Button shows "Saving…" during the request, then "Saved!"
- [ ] Reload the page → all four fields show the saved values
- [ ] Enter `-100` as the estimate amount → validation error appears, no API call made

### Google Sheets Shadow-Write

- [ ] If any lead originated from Google Sheets (ID starts with `GS-`), update its status from the inbox
- [ ] Verify no error state (red border) appears on the status dropdown after the save
- [ ] Reload → the updated status persists (lead was shadow-written to Supabase)

### Data Source Fallback

- [ ] Confirm the inbox or dashboard shows data source label correctly
- [ ] If Supabase has leads: label reads "Supabase"
- [ ] If Supabase is empty and Google Sheets is configured: label reads "Live Google Sheet"

---

## 7. Rollback Plan

### Application Rollback (Vercel)

Vercel keeps every deployment. If a broken deploy goes live:

1. Go to Vercel → **Project → Deployments**
2. Find the last known-good deployment
3. Click **...** → **Promote to Production**
4. Production switches instantly — no rebuild required

- [ ] Note the URL of the last stable deployment before going live

### Database Rollback

The `leads` table is append-only in normal use (no records are deleted by the app). If the migration itself needs to be undone:

```sql
-- Undo migration 001 — drops ALL lead data
DROP TABLE IF EXISTS public.leads;
```

Run this in the Supabase SQL Editor only if you need to reset the schema entirely. There is no automated rollback.

- [ ] Before running the migration, confirm the table does not already exist with conflicting data

### Environment Variable Rollback

If a bad env var causes a build or runtime failure:

1. Go to Vercel → **Project Settings → Environment Variables**
2. Edit the broken variable
3. Trigger a new deployment (push an empty commit or use **Redeploy** in the dashboard)

Changing env vars alone does not redeploy — a redeploy is always required.

---

## 8. Known Pilot Limitations

Document these for the pilot customer so they are not surprised:

| Limitation | Impact | Planned fix |
|---|---|---|
| Single shared login account | No per-user audit trail | Sprint 2 |
| No Row Level Security on `leads` table | Acceptable for single-tenant pilot | Sprint 2 |
| Google Sheets leads shadow-written on first edit only | Lead inbox must be edited at least once to migrate each row | Import script planned |
| Open redirect on login page (`?redirectTo=`) | Low risk for controlled pilot; do not share login URL with untrusted parties | Sprint 2 |
| Session expiry shows generic error, not a redirect | User must manually reload | Sprint 2 |

---

## Sign-Off

| Step | Owner | Status |
|---|---|---|
| Supabase migration run | | |
| Auth configured (Site URL, Redirect URLs) | | |
| Test user created | | |
| Vercel env vars set | | |
| Deployment successful | | |
| All smoke tests passed | | |
| Pilot user credentials delivered | | |
