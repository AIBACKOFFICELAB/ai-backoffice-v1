# 03 — Module Architecture

Every module in AI BackOffice — present and future — implements exactly six
layers. This is not a suggestion. A module missing any layer is not considered
production-complete regardless of how well its core function works.

## The Six Layers

### 1. Configuration

The set of inputs a business owner (or implementation team, during setup)
provides to make the module theirs: business hours, message templates, escalation
thresholds, phone numbers, integration credentials, tone/voice preferences.

- Lives in a dedicated settings surface per module (see [[07_UI_CONSTITUTION]]).
- Must be editable without an engineer's involvement once the module has
  graduated past initial white-glove setup.
- Persisted per-tenant, never hardcoded per-client in application code.

### 2. Trigger

The condition that causes the module to activate: an inbound missed call, a lead
aging past N days without an estimate, a job marked complete, an invoice due
date. Triggers are explicit, inspectable, and testable in isolation from
Execution.

- Every trigger must be independently loggable: "why did/didn't this fire."
- Triggers are the first thing an implementation engineer verifies during
  Activation (see [[04_SYSTEM_LIFECYCLE]]).

### 3. Execution

The actual work the module performs once triggered: drafting a message, sending
an SMS, generating a proposal, summarizing job notes. This is the layer most
naturally thought of as "the feature," but it is only one of six required layers.

- Execution must be idempotent or explicitly guarded against duplicate firing.
- Execution failures must degrade safely (see graceful-fallback precedent in the
  existing leads repository pattern) and must always be recorded in History,
  success or failure.

### 4. History

An immutable, queryable record of every time this module fired, what it did, what
the outcome was, and what data it acted on. History is what makes Article II of
the [[02_PRODUCT_CONSTITUTION]] falsifiable — without it, nobody can prove the
bottleneck was actually removed.

- Every Execution event writes a History row before returning success to the
  caller.
- History is customer-visible where relevant (e.g., "3 follow-up texts sent to
  this lead") and internally auditable always.

### 5. Analytics

Aggregated, rolled-up views of History that answer business questions: how many
missed calls were recovered this month, what is the average time-to-first-contact,
how much revenue is attributable to this module. Analytics is derived from
History, never a separate source of truth.

- Every module ships with at least one dashboard-ready metric by Activation.
- Analytics feeds the Optimization and Reporting stages of
  [[04_SYSTEM_LIFECYCLE]].

### 6. Settings

Module-level operational controls distinct from initial Configuration: pause/
resume the module, adjust thresholds after go-live, opt out of a specific
automation for a specific lead or job, manage notification preferences.

- Settings differs from Configuration in that Configuration is "set it up,"
  Settings is "operate it day to day."
- Every module must be pausable by a human without deleting its History or
  Configuration.

## Rule of Completeness

A module is not "MVP-shipped" until all six layers exist, even in minimal form.
A Trigger with no History is a black box. An Execution with no Settings cannot be
safely operated in production. Future modules may never violate this
architecture; shortcuts here compound directly into support burden.
