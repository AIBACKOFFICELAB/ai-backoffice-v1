# Architecture — P0 Agentic Foundation

Status: P0 complete. This document describes the governed, event-driven,
model-independent foundation added on top of the existing product
(`docs/constitution/`) so AI BackOffice can safely run intelligent,
permissioned agents without destabilizing the two live modules (Missed Call
Recovery, Estimate Follow-up) or the single production tenant currently
running on this system.

See also: `DOMAIN_MODEL.md`, `EVENT_SYSTEM.md`, `MODEL_GATEWAY.md`,
`AGENT_SECURITY.md`, `OUTCOME_ATTRIBUTION.md`, `AGENTIC_ROADMAP.md`, and
`docs/adr/0001-durable-execution-layer.md`.

## Target runtime shape

```
BUSINESS EVENT
      ↓
CONTEXT ENGINE            (today: direct repository reads — leads, settings)
      ↓
SUPERVISOR AGENT          (P0: prototype row only, not wired to any trigger)
      ↓
POLICY / PERMISSION ENGINE   lib/agents/permissions.ts
      ↓
SPECIALIZED AGENT          lib/agents/runtime.ts::runAgent()
      ↓
MODEL GATEWAY              lib/ai/gateway.ts
      ↓
TOOLS / CONNECTORS / MCP   lib/agents/toolRegistry.ts (mock/safe tools only in P0)
      ↓
ACTION
      ↓
VERIFICATION               tool_calls.status + response_summary
      ↓
AUDIT / HISTORY            agent_runs, tool_calls, model_invocations, approvals
      ↓
REVENUE + OUTCOME ATTRIBUTION   lib/outcomes
      ↓
HUMAN EXCEPTION QUEUE      approvals table + /agentic (internal, read-only in P0)
```

P0 builds every layer above at foundation depth — schema, primitives, one
proven end-to-end path (`lib/agents/runtime.test.ts`) — without shipping any
of the seven production specialist agents from the long-term roadmap (see
`AGENTIC_ROADMAP.md`). No customer-facing autonomous action was required or
added.

## What already existed and was preserved unchanged

- Next.js 14 App Router, Supabase/Postgres, `@supabase/ssr` auth, Vercel
  deployment. Not touched.
- Multi-tenancy: `tenants`, `tenant_memberships`, `is_tenant_member()`. Not
  touched.
- Missed Call Recovery and Estimate Follow-up: their Trigger → Execution →
  History → Analytics → Settings layers are unchanged. Missed Call Recovery
  gained a **compatibility adapter** (see below) that observes its existing
  execution and emits events/outcomes alongside it — it does not alter what
  the module does or how it responds to a real call.
- The six-layer module architecture and six-endpoint API convention in
  `docs/constitution/03_MODULE_ARCHITECTURE.md` / `08_API_CONSTITUTION.md`
  govern any future *module*. Agents are a different kind of thing — a
  module is triggered code that always runs the same way; an agent is
  permissioned code whose actions are policy-gated and may require approval.
  Both can coexist; P0 does not ask any existing module to become an agent.

## New foundation (P0)

| Concern | Primitives | Tables |
|---|---|---|
| Canonical domain model | audited, not re-modeled (see `DOMAIN_MODEL.md`) | — |
| Model Gateway | `lib/ai/gateway.ts`, `lib/ai/router.ts`, `lib/ai/providers/*` | `model_invocations` |
| Business events | `lib/events/service.ts`, `lib/events/store.ts` | `business_events` |
| Agent registry | `lib/agents/agentStore.ts`, `lib/agents/seed.ts` | `agents` |
| Agent runtime | `lib/agents/runtime.ts` | `agent_runs`, `tool_calls` |
| Permissions/policy | `lib/agents/permissions.ts` | (agents.approval_policy etc.) |
| Approvals | `lib/approvals/*` | `approvals` |
| Durable execution | `lib/execution/*` | `durable_jobs` |
| Outcome attribution | `lib/outcomes/*` | `outcomes` |

Every table above is additive (migrations `009`–`016`), tenant-scoped
(`tenant_id NOT NULL REFERENCES tenants(id)`), RLS-enabled, and follows the
same "service-role client + explicit `tenant_id` filter in every query"
pattern already used by every existing table — see
`docs/constitution/06_DATABASE_PRINCIPLES.md` and its P0 amendment.

**P0.9 Slice A** (independent Codex acceptance audit remediation) hardened
cross-table tenant consistency, tool authorization, and approval execution
on top of this foundation — see `AGENT_SECURITY.md` for the current,
accurate description of all three, and `db/migrations/017_p0_agentic_foundation_hardening.sql`
for the schema change (written and reviewed; **not yet applied to
production** — see that file's header for status).

## The compatibility-adapter pattern

Per the P0 directive: *"existing workflow → compatibility adapter → new
foundation → gradual native migration."* P0 applies this to exactly one
module (Missed Call Recovery) as the proof, not all of them:

```
executeMissedCallRecovery()          (unchanged control flow)
   ├─ emitEventSafely("call.missed")     ─┐
   ├─ (creates the lead, as before)       │  never affects the return
   ├─ emitEventSafely("lead.created")     │  value or the SMS/email that
   ├─ (sends recovery/owner SMS+email,    │  actually goes out — every
   │   as before)                         │  call is wrapped and logs on
   ├─ emitEventSafely("call.recovered")   │  failure instead of throwing.
   └─ recordOutcomeSafely(lead_recovered)─┘
```

Estimate Follow-up was **not** touched beyond a pure, behavior-preserving
extraction (`renderTemplate`, `computeFollowupDueDates`, `selectDueStep`)
made solely so its existing Day 1/3/7 logic could be regression-tested (see
`lib/modules/estimateFollowup/service.test.ts`). Migrating it onto events is
future work, deliberately deferred — see `AGENTIC_ROADMAP.md`.

## The proven end-to-end path (P0 exit criteria)

`lib/agents/runtime.test.ts` exercises the full chain from the exit
criteria in the P0 directive, entirely against in-memory/mock
implementations of every store and provider (no live DB, no live model
call, no network):

```
emitEvent("test.echo")
  → seedAgents() resolves the dev/test agent (context)
  → runAgent(): AiGateway.reason() invoked (Model Gateway)
  → evaluateToolCall() per planned tool (Policy)
  → ping / create_internal_note execute immediately (AUTO_EXECUTE*)
  → draft_customer_message requires approval → approvals row created,
    agent_run.status = 'awaiting_approval'
  → approveApproval() by a tenant owner
  → resumeAfterApprovalDecision() executes the tool, agent_run → 'succeeded'
  → recordOutcome() attaches an outcome to the completed run
```

This demonstrates: tenant-safety (every store is tenant-scoped and tested
for cross-tenant leakage, `lib/tenantIsolation.test.ts`), observability
(every step is a row), permission-awareness (denies/approval-gates are the
same `evaluateToolCall` production code uses), provider-independence (the
gateway is constructed with a swappable provider map — same test passes
with any `ChatProvider` implementation, see `lib/ai/gateway.test.ts`), and
recoverability (the run genuinely pauses at `awaiting_approval` and resumes
from durable state, not in-memory continuation).

## Explicit non-goals of P0 (see directive §8, §16–19)

- No production specialist agents (Estimate Closing, CSR, etc.).
- No customer-facing autonomous action.
- No full Customer/Property/Job canonical model migration (see
  `DOMAIN_MODEL.md` "Deferred").
- No new paid infrastructure vendor for durable execution (see the ADR).
- No RBAC beyond the existing owner/staff tenant roles.
