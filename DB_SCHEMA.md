# Supabase Database Foundation - AI BackOffice

## Leads Table Schema

The pilot uses a single `leads` table to persist incoming job inquiries and status updates.

### Table: `public.leads`

Columns:
- `id` text PRIMARY KEY
- `date` timestamp with time zone NOT NULL
- `customer_name` text NOT NULL
- `phone` text NOT NULL
- `email` text
- `service_address` text NOT NULL
- `property_type` text NOT NULL
- `service_type` text NOT NULL
- `emergency` text NOT NULL
- `urgency` text NOT NULL
- `job_description` text NOT NULL
- `photos_uploaded` text NOT NULL
- `preferred_appointment_time` text
- `customer_role` text NOT NULL
- `lead_source` text NOT NULL
- `customer_notes` text
- `status` text NOT NULL
- `estimate_amount` numeric NOT NULL DEFAULT 0
- `follow_up_date` text
- `review_request_status` text NOT NULL
- `internal_notes` text
- `source` text
- `created_at` timestamp with time zone NOT NULL DEFAULT now()
- `updated_at` timestamp with time zone NOT NULL DEFAULT now()
- `sms_sent_at` timestamp with time zone

### Indexes
- `idx_leads_status` on `status`
- `idx_leads_follow_up_date` on `follow_up_date`
- `idx_leads_created_at` on `created_at`

## TypeScript Model

The TypeScript lead model now includes optional fields for persistence:
- `source`
- `createdAt`
- `updatedAt`
- `smsSentAt`

New types:
- `LeadInsert` for create payloads
- `LeadUpdate` for partial updates

## Repository Layer

The new repository supports:
- `getLeads()` - loads from Supabase first, then Google Sheets fallback
- `getLeadById(id)` - loads from Supabase first, then fallback
- `createLead(lead)` - inserts a lead into Supabase
- `updateLead(id, update)` - updates a lead in Supabase
- `deleteLead(id)` - deletes a lead from Supabase

## API Routes

### `app/api/leads/index.ts`
- `GET /api/leads` - list leads
- `POST /api/leads` - create a lead

### `app/api/leads/[id]/route.ts`
- `GET /api/leads/{id}` - fetch single lead
- `PUT /api/leads/{id}` - update single lead
- `DELETE /api/leads/{id}` - delete single lead

All routes are protected by Supabase auth via `lib/api-auth.ts`.

## Required Environment Variables

Add these to `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here

GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour private key here\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_ID=your-google-sheet-id
```

## Notes

- Google Sheets integration is preserved as a temporary fallback while Supabase persistence is added.
- No multi-tenant or advanced analytics logic was added.
- The system is intended for a single pilot customer.

---

## P0 Agentic Foundation tables (migrations 009–016)

Added by the P0 Agentic Foundation (see `ARCHITECTURE.md`). Full column
detail lives in the migration files themselves
(`db/migrations/009_business_events.sql` through
`016_durable_jobs.sql`) — this is the summary. Every table below:
`tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`, RLS
enabled, `SELECT` policy via `is_tenant_member()`, writes via the
service-role client only (see `docs/constitution/06_DATABASE_PRINCIPLES.md`'s
P0 amendment below).

| Table | Purpose | Doc |
|---|---|---|
| `business_events` | Canonical cross-module event log | `EVENT_SYSTEM.md` |
| `agents` | Agent registry: type, status, tools, approval/model policy | `AGENT_SECURITY.md` |
| `agent_runs` | One row per agent invocation | `AGENT_SECURITY.md` |
| `tool_calls` | One row per tool a run invoked | `AGENT_SECURITY.md` |
| `model_invocations` | One row per model gateway call | `MODEL_GATEWAY.md` |
| `approvals` | Human sign-off records for gated agent actions | `AGENT_SECURITY.md` |
| `outcomes` | Business-outcome attribution | `OUTCOME_ATTRIBUTION.md` |
| `durable_jobs` | Execution queue (retries/backoff/dead-letter) | `docs/adr/0001-durable-execution-layer.md` |

### P0.9 hardening migrations 017–020 — written, reviewed, NOT yet applied to production

`db/migrations/017` through `020` are additive/corrective migrations on
top of `009`–`016`. **None of them have been run against the live
database** as of P0.9 Slice D — the schema described in the table above
(migrations `009`–`016`) is what's actually live in production today.
Each has been fully proven against a disposable local Postgres 16 with the
entire `001`–`020` sequence applied from empty — see "Running the database
integration suite" below and the P0.9 Slice D completion report for the
exact verification record (constraint names, RLS-as-role results, Postgres
version note).

- **017** (`p0_agentic_foundation_hardening`, Codex findings B-01, B-03,
  M-03): composite `(tenant_id, x) REFERENCES parent (tenant_id, id)`
  foreign keys on every cross-table relationship among the tables above
  (replacing the single-column FKs from migrations `010`–`016`), a
  `payload_digest` column and an `'executing'` status on `approvals`, a
  uniqueness constraint on `tool_calls.approval_id`, and a partial unique
  index on `agents (tenant_id, agent_type)` excluding `'custom'`. See
  `AGENT_SECURITY.md` for what each change enforces.
- **018** (`p0_durable_execution_audit_hardening`, findings H-02, H-04):
  `durable_jobs.lease_token` (the actual per-claim ownership credential —
  see `docs/adr/0001-durable-execution-layer.md`), `tool_calls.policy_snapshot`
  (immutable policy-decision audit, set once at creation), and `'denied'`/
  `'partial'` added to `agent_runs`'s allowed statuses (see
  `AGENT_SECURITY.md`'s truthful-status section).
- **019** (`p0_production_compatibility_privacy`, findings C.3, M-05):
  `outcomes.idempotency_key` + a matching partial unique index (same
  pattern as `business_events`/`durable_jobs`), and
  `model_invocations.error_category` (the normalized failure taxonomy —
  see `MODEL_GATEWAY.md`).
- **020** (`p0_final_security_hardening`, P0.9 Slice D findings D.9, D.11):
  revokes `anon`'s `EXECUTE` on `public.is_tenant_member(uuid)` (`authenticated`'s
  grant is deliberately KEPT — see the migration file's own comment for why:
  migration `003` tried revoking both and it broke RLS for every real
  logged-in user in production, reverted by migration `007`); adds the one
  index genuinely still missing per the P0.9 Slice D index audit,
  `idx_approvals_approver_user_id` (`approvals.approver_user_id` references
  `auth.users`, not a tenant-scoped table, so it was correctly out of scope
  for `017`'s tenant-consistency composite-FK rework).

New required environment variable:

```bash
# Model Gateway (optional — falls back to a deterministic mock provider
# when unset, so dev/CI/tests never need this). See MODEL_GATEWAY.md.
ANTHROPIC_API_KEY=your-anthropic-api-key
```

### Running the database integration suite

Every `lib/**/*.pg.test.ts` file (tenant-consistency FKs, approval
concurrency, durable-job lease/reclaim, cross-table idempotency, the RLS
table matrix, the full exit-criteria demonstration) runs against a REAL
Postgres — not an in-memory re-implementation, which cannot prove a
database-enforced constraint or a genuine concurrent-transaction race
without being circular. See `lib/testHarness/pgTestDb.ts`'s own doc
comment for the full design.

```bash
# 1. Any disposable Postgres 15+ — local, CI service container, or a
#    Supabase branch. NEVER the production project.
# 2. Apply, in order, from empty:
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/shadow_env/000_supabase_scaffold.sql   # local Postgres only — a real Supabase project/branch already has auth.uid()/anon/authenticated/service_role
for f in db/migrations/0*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
# 3. Run the suite — every *.pg.test.ts file executes for real:
DATABASE_URL="postgresql://..." npm test
```

Without `DATABASE_URL` (or `TEST_DATABASE_URL`) set, every `*.pg.test.ts`
suite `describe.skip`s cleanly and explicitly rather than silently passing
— see the P0.9 Slice D completion report's honest test-count breakdown
(skipped is never reported as passed). `.github/workflows/ci.yml`'s
`test-db` job runs this automatically against an ephemeral Postgres
service container on every push/PR.
