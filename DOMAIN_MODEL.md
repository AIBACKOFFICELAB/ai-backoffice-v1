# Domain Model — P0 Audit + Canonical Direction

This document is P0.1's required deliverable: an audit of what exists, what
is preserved, what is new, and — explicitly — what is deferred and why.

## What exists today (preserved)

```
tenants
tenant_memberships  (user_id, tenant_id, role: owner|staff)
leads                — hybrid customer + job + estimate + review-status record
missed_call_recovery_settings / _history
estimate_followup_settings / _sequences / _history
platform_prospects  — pre-tenant sales pipeline, not tenant-scoped
```

`leads` is today's stand-in for the directive's `Customers` → `Jobs` →
`Estimates` hierarchy: one row carries customer identity, service address,
job description, estimate amount, and lifecycle status all at once. This is
a known, previously-documented gap (`docs/constitution/06_DATABASE_PRINCIPLES.md`
flagged introducing a `jobs` table before the second MVP module *before* P0
started) — not something P0 introduced.

## What P0 added

```
business_events    — canonical cross-module event log (see EVENT_SYSTEM.md)
agents              — agent registry (see AGENT_SECURITY.md)
agent_runs          — one row per agent invocation
tool_calls          — one row per tool a run invoked
model_invocations   — one row per model gateway call (see MODEL_GATEWAY.md)
approvals           — human sign-off records (see AGENT_SECURITY.md)
outcomes            — business-outcome attribution (see OUTCOME_ATTRIBUTION.md)
durable_jobs        — execution queue (see the ADR)
```

Every new table that references "the thing this happened to" does so
**polymorphically** — `entity_type text` + `entity_id text` — instead of a
hard foreign key to `leads.id`. This is the one deliberate
forward-compatibility choice P0 made in the schema: when `Customers`/`Jobs`
are eventually split out of `leads`, `business_events`, `agent_runs`,
`tool_calls`, and `outcomes` will not need another migration to point at
them. This is the "small interface... strictly required to prevent future
architectural rework" the P0 directive explicitly allows, not scope creep.

## Deferred: the full canonical hierarchy

The directive's target model is:

```
Tenant
├── Customers → Properties, Conversations, Jobs (→ Job Notes, Photos,
│     Estimates, Invoices, Payments), Reviews
├── Team Members, Technicians, Services, Integrations
├── Agents, Agent Runs, Tool Calls, Approvals, Business Events   ← P0 shipped this half
```

The right half (agentic infrastructure) is what P0 built. The left half
(Customers/Properties/Jobs split out of `leads`, Technicians, Services,
Integrations-as-entities) is **not** built in P0, deliberately:

- No P0 exit criterion requires it — the end-to-end demonstration
  (`lib/agents/runtime.test.ts`) needs an agent, a run, tool calls, an
  approval, and an outcome; it does not need a normalized job.
- `leads` is live, production data for a real paying tenant. Splitting it
  into `customers`/`jobs`/`properties` is a real migration with real
  backfill risk — exactly the kind of change
  `docs/constitution/06_DATABASE_PRINCIPLES.md`'s "Future Extensibility"
  section says to do deliberately, not as a P0 side effect.
- Two of the seven MVP modules that would need it (Invoice Reminders, GC
  Communication Assistant) are themselves still unbuilt per
  `docs/constitution/05_MVP_CONSTITUTION.md` — there is no consumer for the
  split yet.

**Migration path when it is needed:** introduce `customers` and
`properties` tables, backfill from distinct `(tenant_id, phone, email,
service_address)` tuples in `leads`, add `customer_id`/`property_id` to
`leads` (nullable at first), and only then consider whether `leads` itself
should be renamed/split into `jobs`. Do this as its own reviewed migration
when a concrete module needs it — do not do it opportunistically inside an
unrelated feature PR.

## Tenant isolation posture (applies to every table above)

Every new table: `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE
CASCADE`, RLS enabled, a `SELECT` policy scoped via `is_tenant_member()`.
Application code reads/writes through the service-role client
(`lib/supabase/server.ts`), which bypasses RLS — so **every** store in
`lib/events`, `lib/agents`, `lib/approvals`, `lib/outcomes`,
`lib/execution` filters by `tenant_id` explicitly in every query, and
`lib/tenantIsolation.test.ts` pins that contract. RLS is the backstop for
any future direct/anon-key access path, not the enforcement mechanism in
today's application code — see `docs/constitution/06_DATABASE_PRINCIPLES.md`.
