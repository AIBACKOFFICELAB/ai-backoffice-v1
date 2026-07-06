# 02 — Product Constitution

These are the immutable rules of AI BackOffice. They outrank sprint pressure,
customer requests, and engineering convenience. Any feature proposal that
violates this document must be rejected or rewritten until it complies.

## Article I — Purpose

The application exists to implement AI systems for home-service businesses. It is
not a general tool. Every module must trace back to a real business installed on
the platform and a real operational failure that module removes.

## Article II — The Bottleneck Rule

Every feature must eliminate a measurable operational bottleneck. Before a
feature is approved for build, it must answer, in writing:

1. What specific failure does this fix? (e.g. "leads go uncontacted for >1 hour
   after hours")
2. How is that failure currently measured or observed?
3. What is the expected measurable improvement once shipped?

If a feature cannot answer all three, it does not get built.

## Article III — The Six Domains

Every module must improve exactly one (or more) of these six domains. A module
that does not map cleanly to at least one domain is out of scope.

1. **Lead Recovery** — capturing and responding to inbound demand that would
   otherwise be lost (missed calls, after-hours inquiries, abandoned quote
   requests).
2. **Sales** — moving a captured lead toward a signed job (estimate follow-up,
   proposal generation, objection handling).
3. **Operations** — coordinating the work itself once sold (job notes,
   scheduling handoff, GC/subcontractor communication).
4. **Customer Experience** — the customer-facing quality of interaction
   throughout the job lifecycle.
5. **Cash Flow** — getting paid on time (invoice reminders, payment follow-up).
6. **Communication** — keeping every party (customer, crew, GC, office) in sync
   without manual relay.
7. **Reputation** — turning completed jobs into public trust signals (review
   requests, testimonial capture).

(Seven domains are enumerated in practice — Reputation is treated as a first-class
domain alongside the original six named in project scope.)

## Article IV — No "Nice to Have"

No feature may exist solely because it is interesting to build, technically
impressive, or requested once by a single customer without evidence of broader
demand. A feature request must be traced to Article II before it is scheduled.

## Article V — Human Oversight Until Earned

No module may take an irreversible customer-facing action (sending a legal
document, charging a card, submitting a formal proposal) without a human approval
step, unless that specific module has an explicit, documented autonomy
graduation approved by product leadership.

## Article VI — Every Module Obeys the Architecture

Every module — with no exceptions — implements the six layers defined in
[[03_MODULE_ARCHITECTURE]] and the lifecycle defined in
[[04_SYSTEM_LIFECYCLE]]. A module that skips a layer (e.g., ships Execution with
no History) is incomplete, not "MVP-simplified."

## Article VII — Tenant Isolation Is Non-Negotiable

From the moment a second paying client exists on shared infrastructure, tenant
data isolation (RLS or equivalent) is mandatory, not a backlog item. See
[[06_DATABASE_PRINCIPLES]].

## Article VIII — Amendments

This constitution may be amended only by explicit, deliberate decision — never by
silent accumulation of exceptions. Any deviation must be documented in this file
with the date and reason, not left as an undocumented precedent.
