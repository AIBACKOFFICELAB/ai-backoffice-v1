# Agentic Roadmap

P0 (this PR) builds the foundation. This document is what P0 makes
*possible*, not what P0 *ships*. Do not build P1+ items against this
roadmap without re-grounding against the repository at that time — plans go
stale, code doesn't.

## P0 — Agentic Foundation (shipped)

Provider-neutral model gateway, business event log, agent registry +
minimal runtime, permission/approval engine, Postgres-native durable
execution, outcome attribution schema. One proven end-to-end path
(`lib/agents/runtime.test.ts`). One existing module (Missed Call Recovery)
wired via compatibility adapter. Two prototype agents (`dev_test`,
inactive `supervisor` placeholder). Zero production specialist agents. Zero
customer-facing autonomous action.

## P1 — Intelligence

Per the P0 directive:

1. **Production Supervisor Agent** — the `supervisor` agent row exists
   (inactive); building the real one means giving it actual context
   retrieval (beyond the dev/test agent's bare prompt) and a real trigger
   (a business event type it listens for), not just flipping `status` to
   `'active'`.
2. **Intelligent Estimate Closing Agent** — the first specialist. Needs:
   `agent_type: 'estimate_closing'` already valid in the schema; a real
   tool (send SMS/email to a lead) added to `lib/agents/toolRegistry.ts`
   with a `REQUIRE_APPROVAL` policy until trust is earned (per Principle 3);
   `estimate.stalled`/`estimate.viewed` event types (already reserved in
   `KNOWN_EVENT_TYPES`) actually emitted by Estimate Follow-up.
3. **AI Job Notes / Summarization** — first real use of `ai.summarize()`
   outside the dev/test agent.
4. **Revenue Attribution dashboard** — first real consumer of
   `lib/outcomes/service.ts::summarizeOutcomeValue()`; per
   `OUTCOME_ATTRIBUTION.md`, headline `direct` only until `assisted` is
   explicitly labeled as such in the UI.
5. **Human exception/approval inbox** — a real UI on top of `approvals`,
   replacing the read-only `/agentic` internal page. The approve/reject
   API route and owner-only authorization already exist
   (`lib/approvals/service.ts`) — this is a UI project, not a backend one.

**Primary commercial objective (per directive):** prove measurable ROI with
the Estimate Closing Agent specifically before building the rest.

## P2 — Execution

AI Voice/CSR Agent, calendar/booking integrations, **Invoice Pilot Pro**
integration (AGIOS sister product — see "AGIOS ecosystem" below), AR
automation, MCP connector architecture, expanded RBAC.

## P3 — Scale

Self-service onboarding, integration marketplace, A2A interoperability,
multi-location control plane, advanced model routing, advanced agent
governance. Not scoped further here — see the P0 directive §18 for the
full non-exhaustive list. Do not design P0/P1 primitives against P3
speculatively.

## AGIOS ecosystem: Invoice Pilot Pro

AI BackOffice does **not** plan QuickBooks as its AR integration. The
future AR relationship is:

```
AI BackOffice → detects a collection opportunity → AR Agent
   → AGIOS Integration Adapter (not yet built)
   → Invoice Pilot Pro API/event contract
   → invoice generation, payment workflow, reminders, status tracking
   → back to AI BackOffice for customer context + outcome attribution
```

P0 does not build the adapter or couple the two products' databases. What
P0 *does* do that keeps this clean later: `outcomes.outcome_type` already
includes `invoice_collected`, and every P0 table uses polymorphic
`entity_type`/`entity_id` references rather than hard foreign keys into
`leads` — so an `invoice_collected` outcome sourced from an external
Invoice Pilot Pro event, arriving through a future adapter, needs no schema
change to record. Invoice Pilot Pro remains the system of record for
invoice/AR state; AI BackOffice remains the orchestration/context layer.
Do not duplicate invoice-state ownership when building the adapter.

## What P0 deliberately did not build (see ARCHITECTURE.md "Explicit
non-goals")

Full Customer/Property/Job canonical model, production specialist agents,
customer-facing autonomous actions, a new durable-execution vendor, RBAC
beyond owner/staff.
