# 06 — Database Principles

AI BackOffice runs on Supabase (PostgreSQL). These are the permanent standards
for how data is modeled, isolated, and audited as the platform grows from one
pilot tenant to many.

## Tenant Isolation

- Every table that stores client business data must carry a `tenant_id` (or
  `business_id`) column from the moment a second paying client exists. This is
  not deferrable past that trigger point — see Article VII of the
  [[02_PRODUCT_CONSTITUTION]].
- The current `leads` table (`db/migrations/001_create_leads_table.sql`) has no
  tenant column and no RLS. This is acceptable only as long as exactly one
  client's data lives in it. The first schema task of any multi-client sprint is
  adding tenant isolation, not a new feature.
- Application code must never rely on "the frontend only shows tenant X's rows"
  as an isolation mechanism. Isolation is enforced at the database layer (RLS),
  not the UI layer.

## Row-Level Security (RLS)

- RLS is mandatory on every table containing tenant data before that table is
  used by more than one tenant, no exceptions.
- Policy pattern: every table's RLS policy checks the authenticated user's
  tenant membership against the row's `tenant_id`. Service-role access (used by
  server-side automation jobs) is the only path allowed to bypass RLS, and every
  such usage must be deliberate and reviewed, not a default.
- RLS policies are version-controlled as migrations alongside the tables they
  protect — never applied ad hoc through the Supabase dashboard without a
  corresponding migration file.

## Audit Logs

- Any write to a customer-facing record (lead status change, invoice status,
  proposal sent, review request sent) must be attributable: who/what triggered
  it (a specific user, or a specific module's automated Trigger), and when.
- Audit logging is distinct from module History (see
  [[03_MODULE_ARCHITECTURE]]): History is module-scoped and business-outcome
  oriented ("3 follow-ups sent"); audit logs are security/compliance oriented
  ("user X changed lead Y's status from A to B at time T").
- Audit log tables are append-only. No `UPDATE` or `DELETE` policy is ever
  granted on audit tables at the application layer.

## Automation History Storage

- Every module's History layer (per [[03_MODULE_ARCHITECTURE]]) gets its own
  table, scoped by module and tenant: e.g. `missed_call_recovery_history`,
  `estimate_followup_history`. Do not collapse all module history into one
  generic "events" table — module-specific columns (what was sent, what
  template, what the trigger condition was) need first-class columns, not a
  JSON blob, for the fields that Analytics will query on.
- Free-form/variable payloads (e.g., full AI-generated draft text) may live in a
  JSONB column within the module's history table, but the fields used for
  filtering/aggregation (status, timestamps, tenant_id, lead_id) must be real
  columns with indexes.

## Analytics Storage

- Analytics views are derived, not authoritative: build them as SQL views or
  materialized views over History tables, never as a hand-maintained parallel
  table that can drift from History.
- Materialize only when a specific dashboard's query performance requires it;
  default to live views for MVP-scale data volumes.

## P0 Amendment (Agentic Foundation)

*Added per Article VIII of [[02_PRODUCT_CONSTITUTION]] — deliberate,
dated, documented here rather than left as undocumented precedent. Date:
see git log for this amendment's introducing commit.*

The P0 Agentic Foundation (see `../../ARCHITECTURE.md`) added
`business_events`, `agents`, `agent_runs`, `tool_calls`,
`model_invocations`, `approvals`, `outcomes`, and `durable_jobs`
(migrations `009`–`016`). `business_events` in particular could look like
it violates "Automation History Storage" below — it doesn't:

- **`business_events`** is a cross-module orchestration/observability log
  (JSONB payload, read by the agent runtime and future infra) — not a
  replacement for any module's History table. This document's rule against
  collapsing "all module history into one generic events table" is about
  the business-outcome-facing, first-class-columned History layer required
  by [[03_MODULE_ARCHITECTURE]] (`missed_call_recovery_history`,
  `estimate_followup_history`, and their successors). Those tables are
  unchanged and remain the source of truth for module Analytics. See
  `../../EVENT_SYSTEM.md` for the full distinction.
- Every P0 table follows every existing rule in this document unchanged:
  `tenant_id NOT NULL`, RLS enabled with a tenant-membership `SELECT`
  policy, writes via the service-role client with explicit `tenant_id`
  filtering in application code (RLS is the backstop, not the enforcement
  mechanism — see "Row-Level Security" above), migrations as the only
  accepted schema-change path.
- Entity references on the new tables (`entity_type`/`entity_id`) are
  polymorphic rather than hard foreign keys into `leads` — see
  `../../DOMAIN_MODEL.md` for why, and for what canonical-model work (a
  `customers`/`jobs`/`properties` split) remains deliberately deferred.

## Future Extensibility

- New modules (post-MVP) must be able to add their Configuration, History, and
  Settings tables without modifying the core `leads`/`jobs`/`tenants` schema —
  new modules attach via `tenant_id` and `lead_id`/`job_id` foreign keys, they do
  not require altering shared core tables.
- Establish a `tenants` (or `businesses`) table and a `jobs` table as core
  entities before the second MVP module (Estimate Follow-up) ships — several MVP
  modules (Invoice Reminders, GC Communication Assistant) require a job concept
  that does not yet exist in the schema, and retrofitting it late is expensive.
- Migrations are the only accepted way to change schema. Every schema change
  ships as a numbered file in `db/migrations/`, mirroring the existing
  `001_create_leads_table.sql` convention.
