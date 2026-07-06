# 01 — Product Vision

## Mission

AI BackOffice exists to implement AI-driven operational systems inside home-service
businesses — plumbing, HVAC, electrical, roofing, cleaning, and adjacent trades — so
that no lead, estimate, invoice, or review is ever lost to human bandwidth limits.

We do not sell software as an abstraction. We sell the elimination of specific,
measurable operational failures: missed calls, stalled estimates, unbilled jobs,
un-requested reviews, and unclear job communication.

## Target Customer

- **Primary:** Independent and small-fleet home-service operators (1–25 trucks),
  typically owner-operated, with no dedicated office staff and no existing CRM
  discipline.
- **Secondary:** General Contractors who coordinate multiple trade subcontractors
  and need a single communication thread per job.
- **Explicitly not the target (for now):** Enterprise field-service organizations
  with existing ERP/CRM stacks (ServiceTitan, Housecall Pro, Jobber). We compete on
  speed-to-value and installed-system simplicity, not feature parity with
  enterprise suites.

## Core Philosophy

1. **Implementation over software.** The product's value is delivered the day a
   system goes live inside a business, not the day a feature ships in the
   changelog.
2. **Bottleneck-first.** Every system we build must map to a named, measurable
   operational bottleneck the customer already feels (see
   [[02_PRODUCT_CONSTITUTION]]).
3. **Human-in-the-loop by default.** AI drafts, summarizes, and recommends. A human
   approves anything customer-facing until trust and data volume justify
   autonomy. Autonomy is earned per-module, not assumed platform-wide.
4. **Boring, reliable infrastructure.** Contractors do not care about our stack.
   They care that the SMS goes out at 9pm on a Friday when their phone is off.
   Reliability is a feature, not an operational cost.

## Business Model

AI BackOffice is sold as an **AI implementation engagement**, not a self-serve SaaS
signup. The landing page funds discovery calls; the application is the delivery
and operations backbone that runs the systems we implement for each client.

## Primary Revenue Model

Monthly subscription per business, tiered by number of active automation modules
and lead volume, plus a one-time setup/implementation fee per module activated.
This mirrors the AGIOS Pricing Constitution: implementation fee funds the human
setup cost; the subscription funds ongoing monitoring, model usage, and support.

## Future Revenue Model

- **Usage-based add-ons** (SMS/voice minutes, proposal generation volume) once
  usage patterns are well understood.
- **Marketplace/integration revenue** once a module ecosystem exists (v2.0+).
- **Multi-location / franchise pricing** once tenant isolation and RBAC exist.

We do not build these prematurely. See Non-goals.

## Unique Positioning

AI BackOffice is not "a CRM for contractors" and not "a chatbot for contractors."
It is the **implementation layer**: a company that installs a specific set of
proven automations into an existing business's workflow, using AI where it
removes work and humans where trust or nuance is still required. Competitors sell
tools the customer must configure; we sell outcomes the customer receives.

## Long-term Vision

Every home-service business runs a lean, AI-operated back office by default — one
where missed revenue from operational failure (not lack of demand) is
structurally close to zero. AI BackOffice becomes the operating layer that other
AGIOS products (Signal Atlas, Business Discovery Advisor) can plug signal and
insight into, once each stands on its own revenue.

## Non-goals

- We are not building a general-purpose CRM.
- We are not building a field-service scheduling/dispatch platform.
- We are not building enterprise multi-location ERP features before the MVP
  proves revenue.
- We are not merging with other AGIOS products before each is independently
  revenue-validated.
- We do not ship a feature because it is technically interesting or "nice to
  have" — see [[02_PRODUCT_CONSTITUTION]].

## Success Metrics

- Time from signed client to first live automation: **< 5 business days**.
- Number of paying clients on at least 1 MVP module: **primary early-stage KPI**.
- Missed-lead recovery rate per client (leads contacted within 5 minutes of
  inbound): **target > 90%**.
- Monthly churn per client: **< 5%** once past the second billing cycle.
- Support burden per client per month (hours): tracked and expected to fall as
  modules mature from Configuration → Optimization (see
  [[04_SYSTEM_LIFECYCLE]]).
