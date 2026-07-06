# 04 — System Lifecycle

Every automation module in AI BackOffice moves through the same seven-stage
lifecycle, from first client conversation to steady-state operation. This
lifecycle is the operational counterpart to the six architectural layers in
[[03_MODULE_ARCHITECTURE]] — the layers are what a module *is*; the lifecycle is
what happens to it *over time*.

```
Discovery
    ↓
Configuration
    ↓
Activation
    ↓
Execution
    ↓
Monitoring
    ↓
Optimization
    ↓
Reporting
```

## 1. Discovery

The implementation team (or, eventually, a guided self-serve flow) identifies
which of the client's real operational bottlenecks map to which module, per
Article II/III of the [[02_PRODUCT_CONSTITUTION]]. Output: a scoped list of
modules to activate for this client, in priority order.

- Never skipped, even for "obvious" clients — a plumber and an HVAC company do
  not have identical bottleneck profiles.
- Discovery output is recorded per-tenant so future team members know *why* a
  given module was or wasn't activated for this client.

## 2. Configuration

The client's specifics are entered into the module's Configuration layer:
business hours, templates, thresholds, phone numbers, tone. This stage ends when
the module has everything it needs to be triggered correctly.

- Exit criteria: a configuration checklist specific to the module is fully
  filled, not "looks about right."

## 3. Activation

The module is turned on in a controlled way — typically shadow mode or a single
test trigger first, then live for the client's real traffic. This is where
Trigger correctness is verified against real data before Execution is trusted
to run unattended.

- Exit criteria: at least one real trigger has fired correctly and its History
  entry has been manually reviewed.

## 4. Execution

The module runs in production against live client traffic. This is steady-state
operation of the Execution layer described in
[[03_MODULE_ARCHITECTURE]].

## 5. Monitoring

Ongoing observation of whether the module is behaving as expected: are triggers
firing at the expected rate, are executions succeeding, is History showing
expected outcomes. Monitoring is what catches silent failure before it becomes a
client complaint.

- Minimum bar: someone (human or automated alert) reviews module health on a
  defined cadence per client, not only when something breaks.

## 6. Optimization

Using Analytics and History, the module's thresholds, templates, or triggers are
refined to improve the metric that justified building it in the first place
(Article II). Optimization is where a module earns expanded autonomy per
Article V of the [[02_PRODUCT_CONSTITUTION]], if warranted.

## 7. Reporting

The client (and internally, AI BackOffice) sees the measurable business impact of
the module: leads recovered, revenue attributable, time saved. Reporting closes
the loop back to Discovery — it is the evidence that justifies activating the
*next* module for this client, or expanding this module's scope.

- Reporting output directly feeds retention and upsell conversations, and
  informs the roadmap in [[10_ROADMAP]].

## Why This Order Matters

Skipping stages (e.g., Activation straight to unattended Execution, or Execution
with no Monitoring) is the most common cause of client-facing failures in
AI-driven systems: a misfired SMS, a wrong-tone proposal, a missed invoice
reminder. The lifecycle exists specifically to make those failures rare and, when
they happen, immediately visible via History and Monitoring rather than
discovered by the client first.
