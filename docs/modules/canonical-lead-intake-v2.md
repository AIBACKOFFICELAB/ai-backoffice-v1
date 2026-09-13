# Canonical Lead Intake v2

Status: implementation for Founder review. No production migration or cutover executed.
Accepted base: `bc941dc950943f855a5fbb29b828ad1740ac0df0`.

## Discovery and scope

The observed failure is a real service request landing in Google Forms/Sheets but
not Lead Inbox: `getLeads(tenantId)` returns nonempty Supabase results before
reading Sheets. Those are separate stores, not a synchronization problem to solve.
Success for this sprint is one tenant-bound Supabase lead and one governed event
per submitted identity, readable through the ordinary Lead Inbox and lifecycle.

Existing writers were authenticated `POST /api/leads`, Missed Call Recovery, and
the Sheet shadow-write in `PUT /api/leads/[id]`. The latter preserved `GS-*` row IDs.
There was no native public form and no authenticated Add Lead UI. Native service
requests now enter the shared domain service. Existing Missed Call Recovery is
preserved as a legacy writer; no new channel adapter or changes to Twilio were added.

Authenticated tenancy resolves through Supabase-verified user membership.
`tenants.slug` is already unique and non-null, with no application slug-edit path.
Public requests resolve that identifier on the server and require `status=active`.
Slugs are public routing identifiers, never authentication credentials. Treat a
published slug as stable. No new tenant identifier or tenant-table migration is needed.

`lead.created` already exists in the governed event registry. Its payload guard
now also rejects raw lead PII. The legacy MCR payload remains valid. `tenants.email`
is available for operator notifications through existing Resend infrastructure;
Google Form notification behavior itself is external to this repository.

This is a domain intake boundary, not a new automation module or agent. It creates
no model invocation, agent run, tool call, approval, outcome or follow-up sequence.
Estimate Closing, Estimate Sent validation and Day 1/3/7 behavior are unchanged.

## Routes and contract

- Public page: `/request/<tenant-slug>`; public POST: `/api/request/<tenant-slug>`.
- Authenticated page: `/leads/new`; authenticated POST: `/api/leads`.
- Both call `createCanonicalLeadFromIntake` with server-resolved identity.
- `POST /api/leads` now accepts the bounded intake payload rather than unchecked
  `LeadInsert`. There are no existing browser creation consumers in the accepted
  tree. Any external caller of this authenticated endpoint must adopt this contract.
- Payload fields: `sourceRef` (UUID v4), `customerName`, `phone`, optional `email`,
  `serviceAddress`, `propertyType`, `serviceType`, `emergency`, `urgency`,
  `jobDescription`, optional `preferredAppointmentTime`, `customerRole`,
  `leadSource`, optional `customerNotes`; honeypot `website` must be empty.
- `leadSource` is the customer's marketing/referral answer. `source` is separate,
  server-owned provenance (`website_form` or `manual`). No customer identity,
  source, status, estimate amount, tenant ID or internal field is mass-assigned.
- New leads always use UUID identity, status `New`, estimate amount 0, no photos,
  no follow-up date, and review status `Not Ready`. Appointment preference is not
  a booking. Notes mentioning price never imply Estimate Sent.

## Migration 023 and idempotency

`023_canonical_lead_intake_provenance.sql` adds only:

| Delta | Purpose |
| --- | --- |
| `leads.source_ref text NULL` | Durable adapter submission identity |
| `leads.intake_schema_version integer NULL` | Recorded validation contract version; new intake uses 1 |
| `leads.received_at timestamptz NULL` | Server receipt time, preserved on retry |
| Unique partial index `(tenant_id, source, source_ref) WHERE source_ref IS NOT NULL` | Prevent concurrent duplicate leads |

Existing `source text` is reused and remains open to future sources. Nullable
columns avoid rewriting or inventing provenance for existing records and preserve
legacy writer compatibility. RLS and anonymous grants are unchanged. Migration is
repeatable and non-destructive. Written/tested locally, NOT applied to production.

The browser creates a UUID and retains it in session storage across retries and
refreshes until confirmed. Only the identity is stored there, not customer data.
When browser storage is unavailable, the in-memory identity protects retries in
that page instance. Different jobs must use different identities. Replaying an
identity returns its original lead; it never overwrites the lead or starts a new job.
A new confirmed form session creates a fresh identity. This does not dedupe by
phone/email/customer name.

The persistence adapter attempts an insert. On PostgreSQL unique violation it
looks up the original using all three identity components. No check-then-insert
race or application-memory lock is relied on. The event uses the existing unique
`(tenant_id, idempotency_key)` index with `lead.created:<canonical-lead-id>`.

Lead and event writes are two durable operations, not a cross-table transaction.
Success is returned only after both exist. If event creation fails after lead
persistence, the lead remains and the response is a sanitized retryable 503. A
retry with the same identity repairs the event gap without another lead/event.
If the caller never retries after a crash, a lead can remain without its event;
operators must investigate such gaps. No background repair job or event consumer
is introduced in this sprint. Do not describe this as atomic exactly-once delivery.

## Notification and failure semantics

Only the request that first persists the unique lead-created event attempts an
owner email. Recipient is trusted tenant configuration, never a form field.
The message contains bounded service metadata and the canonical lead reference;
customer contact details and notes remain in Lead Inbox. Missing recipient or
Resend configuration is logged. Failure/timeouts are logged without rolling back
lead/event or making the customer resubmit. Delivery is best effort, with a bounded
wait; a crash after the event but before email can miss the notification, and an
email timing out may still finish later. No guaranteed-delivery claim is made.
No customer email/SMS or new email vendor is introduced.

## Public security boundary

Validation runs before elevated DB access. JSON bodies are capped at 16 KiB by
actual streamed byte count, even without Content-Length. String limits and exact
existing domain enums are shared between form and server. Phone values are bounded
and normalized; optional email is format-checked. Unknown fields are refused.
JSON Content-Type is required, cross-origin browser POSTs are refused, and the
honeypot rejects simple bot submissions. There is no CORS or anonymous table-write
grant. Unknown/paused tenants return a safe 404. Public success reveals neither
canonical lead data nor tenant IDs. Unexpected failures never return DB errors.

The cookie-free Supabase adapter is guarded with `import "server-only"`, uses only
server service credentials, and exports narrow intake operations. Visitor auth
cookies cannot replace its elevated Authorization header. The existing event store
accepts this client through an optional dependency seam; its default behavior is
unchanged for all previous consumers. No production credential/config change is needed.

Honeypot and origin checks are not distributed rate limiting. Review traffic and
existing hosting abuse controls at rollout. If sustained abuse requires shared
rate-limit infrastructure, scope that explicitly as a follow-up; no paid service,
CAPTCHA, or unreliable in-memory distributed limiter is silently added here.

## Legacy compatibility

Google Form/Sheet integration is not deleted, synchronized or made canonical.
After a successful empty Supabase read, the existing Sheet bootstrap reader remains.
Nonempty canonical results always win without concatenation. A DB read failure now
returns unavailable rather than switching to potentially stale Sheet truth.
The legacy Sheet configuration remains global and has no per-tenant binding; do
not expand that bootstrap path to additional tenants. Retire it after pilot cutover.

`GS-*` leads are marked read-only in Inbox/detail and refused operational PUT/DELETE.
The old Sheet shadow-write is removed. Use New lead to record a legacy job as a
canonical lead before working it. Existing canonical records are not deleted,
backfilled, renamed or rewritten. New official service requests bypass Sheets.

## Validation and environment boundary

The ordinary suite skips database tests when no test DB URL is set. The full suite
uses the existing `pgTestDb` harness with a fresh PostgreSQL database, scaffold and
migrations 001–023. Intake DB tests run the production service, persistence adapter,
event store and API/lifecycle over a test-only Supabase query adapter issuing real
PostgreSQL queries. This proves mappings, tenant filters, constraints and races;
it does not itself test PostgREST HTTP transport or Supabase authentication.
The real SDK's credential headers/slug query are separately tested with intercepted
fetch; no test request reaches production or sends a real notification.

The test matrix includes public/unknown/paused tenants, forged tenant rejection,
concurrent and repeated submissions, distinct jobs, provenance, event privacy and
retry repair, secondary notification failure, existing readers and Estimate Sent,
RLS, unchanged data after migration reapplication, and zero governance side effects.

## Founder-controlled production cutover — NOT executed

1. Review the PR, test evidence, migration and limitations; explicitly accept it.
2. Merge accepted code into main (no automatic merge).
3. Apply accepted migration 023 to the correct production database through the
   approved migration procedure; verify the unique index and unchanged RLS.
4. Deploy the accepted production revision and verify server-only credentials and
   existing Resend configuration. Never expose the service key in client settings.
5. Verify the intended tenant's existing slug and active status. Reuse the slug;
   change it only if necessary and explicitly approved. Verify `tenants.email` is
   the intended owner/operator address. No hardcoded tenant UUID is needed.
6. Open `/request/<verified-slug>` and submit one controlled Founder test request
   with clearly synthetic details and a unique sourceRef.
7. Confirm exactly one tenant-bound canonical UUID lead in Supabase, with `New`,
   estimate amount 0, provenance version 1 and server receipt timestamp.
8. Confirm the same lead in Lead Inbox and Lead detail, plus one privacy-safe
   `lead.created` event. Confirm owner notification or investigate its logged failure.
9. Replay the same sourceRef and confirm no duplicate lead/event. Confirm zero
   agent runs, model calls, tool calls, approvals or outcomes caused by intake.
10. Only after acceptance, replace the 5 Star Plumbing website/form link with the
    verified Intake v2 URL. Keep the legacy Google Form/Sheet available as read-only
    history temporarily; do not silently treat ongoing legacy submissions as ingested.
11. Observe request counts, lead visibility, event gaps and notification failures.
    If rollback is needed, stop directing customers to the new form and investigate;
    preserve all canonical leads and provenance. Do not drop the migration or merge
    legacy stores. Avoid accepting new legacy submissions without an explicit
    operator process to enter them canonically.
12. Use the next genuine lead for real Estimate Closing evidence through the
    ordinary authorized lifecycle. Shadow remains active; Human Approval remains
    unauthorized, with allowedTools=[], writeScopes=[], approvalPolicy={}.
13. After a Founder-approved observation period, retire the legacy Sheet bootstrap
    in a separate cleanup. No date or automatic retirement is assumed here.

P2 is not started. No new agent, integration platform, production backfill,
production migration, website-link change or automatic merge is part of this PR.


## Local validation evidence

- `npm run typecheck`: pass.
- `npm run lint`: pass (existing Next lint deprecation/workspace-root notices).
- `npm run build`: pass.
- Ordinary `npm test`: 839 passed, 95 DB tests skipped, 934 total.
- Full fresh-PostgreSQL `npm test`: 934 passed, zero skipped (baseline 871; +63).
- `git diff --check`: pass. Frozen lifecycle/Estimate Closing files unchanged.
- Browser: public request submitted successfully at 390px width through the built
  Next app, real Supabase SDK, local PostgREST and disposable PostgreSQL. Confirmed
  one UUID lead, `New`, amount 0, `website_form`, version 1 and one `lead.created`.
  Focus moves to the accessible confirmation heading after success.
- That browser check caught an internal-hostname origin mismatch; the guard now
  checks the actual incoming Host and has regression tests for proxy/opaque origins.
- Full public-page → authenticated Inbox → detail browser flow: NOT validated.
  No non-production Supabase Auth environment was available. Reader/API/Estimate
  Sent integration tests pass, but are not a claim of an authenticated browser test.
- No production customer data, email delivery, Supabase mutation or hosted preview
  submission was used. Local test email credentials were absent; notification
  failures were tested with fakes. Production migration remains unapplied.
