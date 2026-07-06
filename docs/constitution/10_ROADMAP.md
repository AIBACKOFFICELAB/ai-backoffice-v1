# 10 — Roadmap

Every milestone below maps back to the seven MVP systems defined in
[[05_MVP_CONSTITUTION]], obeys [[03_MODULE_ARCHITECTURE]] and
[[04_SYSTEM_LIFECYCLE]], and is scoped against the Non-goals in
[[01_PRODUCT_VISION]].

## Beta

**Business objective:** Prove the delivery model works end-to-end for one paying
pilot client using the current single-tenant app.

**Technical objective:**
- Add tenant isolation groundwork (`tenants` table, `tenant_id` on `leads`) even
  while serving one client, so RLS can be turned on without a painful migration
  later (see [[06_DATABASE_PRINCIPLES]]).
- Wire Missed Call Recovery's Trigger layer to a real missed-call event
  (currently Execution-only, manually invoked).
- Remove dead code (`PageTitle.tsx`, `data/mockData.ts`, `data/mock.ts`).
- Stand up CI (lint, typecheck, minimal test suite) — a prerequisite, not an
  MVP module itself.

**Completion criteria:** One real client is running Missed Call Recovery live,
with History and basic Analytics visible, and the schema is tenant-isolation-
ready.

**Revenue impact:** Validates the implementation-fee + subscription model on a
single client before scaling client count.

## MVP

**Business objective:** Have all seven systems in [[05_MVP_CONSTITUTION]]
live, at minimal-viable depth, for the first 2–5 paying clients.

**Technical objective:**
- RLS enforced on all tenant tables (mandatory once client #2 onboards —
  Article VII).
- Introduce a `jobs` table (required by Invoice Reminders and GC Communication
  Assistant, which have no data model today).
- Build out Estimate Follow-up, Review Requests send-path, and Invoice
  Reminders — the three systems currently at 0% Execution.
- Every module satisfies all six layers of [[03_MODULE_ARCHITECTURE]] and
  exposes all six endpoints of [[08_API_CONSTITUTION]].

**Completion criteria:** All seven MVP modules are Activated (per
[[04_SYSTEM_LIFECYCLE]]) for at least one client each, with Reporting evidence
of measurable impact.

**Revenue impact:** This is the point at which the sales motion described on the
landing page (audit call → paid implementation) is fully deliverable without
manual engineering workarounds per client.

**Dependencies:** Beta's tenant-isolation groundwork and CI must be complete
first; building new modules on an un-isolated schema multiplies migration risk.

## v1.0

**Business objective:** Reduce implementation time per new client and start
self-serve elements for the lowest-friction modules.

**Technical objective:**
- AI Job Notes Summarizer and Proposal Generator reach full autonomy-graduation
  review (Article V) where appropriate.
- Stripe billing integration replacing manual invoicing of AI BackOffice's own
  clients.
- Self-serve Configuration UI for already-activated modules (client can adjust
  thresholds/templates without engineering involvement), per the Settings layer
  in [[03_MODULE_ARCHITECTURE]].

**Completion criteria:** A new client can be Discovered, Configured, and
Activated on all seven MVP modules in under 5 business days (per the Success
Metric in [[01_PRODUCT_VISION]]) without custom engineering work.

**Revenue impact:** Lowers cost-to-serve per client, improving margin on the
existing subscription price point.

## v2.0

**Business objective:** Expand beyond the seven MVP modules into the next tier
of value (matching the Growth/Premium tiers already referenced on the landing
page) and introduce team-level access.

**Technical objective:**
- RBAC / multi-user-per-tenant (owner, office staff, technician roles).
- Integration marketplace groundwork — third-party tools clients already use
  (scheduling, accounting) connect into the module Trigger layer.
- Usage-based billing add-ons (SMS/voice volume, proposal generation volume) per
  the Future Revenue Model in [[01_PRODUCT_VISION]].

**Completion criteria:** At least one new post-MVP module is live end-to-end
using the same six-layer/six-endpoint architecture, proving the architecture
generalizes beyond the original seven.

**Revenue impact:** Unlocks upsell revenue from existing clients rather than
relying solely on new-client acquisition.

## v3.0

**Business objective:** Only pursued if v2.0 has proven sustained multi-client,
multi-module revenue — evaluate cross-AGIOS integration (Signal Atlas, Business
Discovery Advisor) at this point, not before.

**Technical objective:** Define a data/insight-sharing contract between AI
BackOffice and other independently-revenue-validated AGIOS products, without
merging codebases or business models (see Non-goals in
[[01_PRODUCT_VISION]]).

**Completion criteria:** A documented, opt-in integration exists between AI
BackOffice and at least one sibling AGIOS product, with no degradation to AI
BackOffice's own tenant isolation or reliability.

**Revenue impact:** Speculative at this horizon — explicitly not planned in
technical or database decisions made before v2.0 ships, to avoid premature
coupling.
