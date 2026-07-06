# 05 — MVP Constitution

The official MVP of AI BackOffice consists of exactly seven systems. No system
outside this list may be built under the "MVP" label. Anything else — self-serve
signup, RBAC, multi-location support, an integrations marketplace — is explicitly
deferred (see [[10_ROADMAP]]).

Each system below is a **module** in the sense of [[03_MODULE_ARCHITECTURE]] and
must pass through the full lifecycle in [[04_SYSTEM_LIFECYCLE]]. Each maps to at
least one domain from Article III of [[02_PRODUCT_CONSTITUTION]].

## 1. Missed Call Recovery

- **Domain:** Lead Recovery, Communication
- **Bottleneck:** Inbound calls that go unanswered (after hours, on a job site,
  during a busy day) currently result in a lost or cold lead.
- **Trigger:** Missed call detected on the business's tracked line.
- **Execution:** Immediate automated SMS to the caller acknowledging the missed
  call and prompting a callback window or quick-reply intake; internal alert to
  the owner for emergency-flagged calls.
- **Current repo state:** Twilio emergency-alert endpoint exists
  (`app/api/sms/emergency-alert/route.ts`) but is manually triggered, not wired
  to a missed-call Trigger. This is the highest-priority gap to close.

## 2. Estimate Follow-up

- **Domain:** Sales
- **Bottleneck:** Estimates sent (or leads awaiting a quote) go stale with no
  systematic follow-up, and jobs are lost to whichever competitor followed up
  first.
- **Trigger:** Lead has been in an "estimate sent" or "awaiting response" status
  for N days with no status change.
- **Execution:** Sequenced follow-up messages (Day 1 / 3 / 7 by default,
  configurable) via SMS/email.
- **Current repo state:** Not implemented. `follow_up_date` field exists on the
  leads table and a `/follow-ups` page surfaces overdue leads, but there is no
  automated sequence — it is a manual worklist today.

## 3. AI Job Notes Summarizer

- **Domain:** Operations, Customer Experience
- **Bottleneck:** Field techs leave short, inconsistent job notes; office staff
  and future techs lack context, and customers get no clear record of what was
  done.
- **Trigger:** Job marked complete, or raw notes/photos submitted for a job.
- **Execution:** AI-generated structured summary (what was found, what was done,
  what's recommended next) from raw tech input.
- **Current repo state:** Not implemented. `job_description` and
  `customer_notes` fields exist on the leads table; no summarization logic.

## 4. Proposal Generator

- **Domain:** Sales
- **Bottleneck:** Writing a clean, professional proposal/estimate document takes
  time office staff or owners don't have, delaying the sales cycle.
- **Trigger:** Owner/tech requests a proposal for a qualified lead, or estimate
  amount is entered.
- **Execution:** AI drafts a proposal document from job details and estimate
  data; human reviews and sends (per Article V — no autonomous send at MVP).
- **Current repo state:** Not implemented. `estimate_amount` field exists; no
  document generation.

## 5. Review Requests

- **Domain:** Reputation
- **Bottleneck:** Completed jobs generate almost no reviews because asking is
  manual and easily forgotten.
- **Trigger:** Job marked complete / invoice paid.
- **Execution:** Automated request (SMS/email) to the customer with a direct
  review link; tracked through to completion.
- **Current repo state:** Partial. `/review-requests` page exists as a read-only
  kanban (`review_request_status` field), but there is no send action — Execution
  and Trigger layers are both missing.

## 6. Invoice Reminders

- **Domain:** Cash Flow
- **Bottleneck:** Unpaid invoices go uncollected past due date because manual
  follow-up is inconsistent.
- **Trigger:** Invoice due date passed with no payment recorded.
- **Execution:** Sequenced payment reminders to the customer, escalating in tone/
  urgency.
- **Current repo state:** Not implemented. No invoice concept exists in the
  current schema at all — this requires new data model work, not just new UI.

## 7. GC Communication Assistant

- **Domain:** Communication, Operations
- **Bottleneck:** Jobs involving a general contractor require constant manual
  status updates across phone/text/email, consuming owner time and creating
  communication gaps.
- **Trigger:** Job status change on a GC-linked job.
- **Execution:** Automated, on-brand status update sent to the GC contact at
  defined milestones, with owner able to review/edit before send.
- **Current repo state:** Not implemented. No GC/job-linkage concept exists in
  the current schema.

## MVP Discipline

- These seven and only these seven constitute "MVP." Sprint planning may
  sequence them (see [[10_ROADMAP]]) but may not add an eighth without amending
  this document.
- Every one of the seven must satisfy [[03_MODULE_ARCHITECTURE]]'s six layers
  before being considered complete — a Trigger-and-Execution-only version of any
  of these is a prototype, not an MVP-complete module.
