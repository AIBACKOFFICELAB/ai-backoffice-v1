# ADR 0001 — Durable Execution Layer: Postgres-native queue, not a new vendor

**Status:** Accepted. **Date:** see git log for this file's introducing
commit. **Scope:** P0.6 of the Agentic Foundation directive.

## Context

The directive asks for durable execution (retries, exponential backoff,
idempotency, concurrency control, dead-letter, scheduled execution,
correlation IDs, tenant isolation) that can scale from hundreds to
potentially millions of workflow executions, and names candidates:
Supabase-native primitives, Inngest, Trigger.dev, Upstash/QStash, or
another justified system.

Current reality of this repo:

- Two live modules already run on **direct Vercel Cron** (Estimate
  Follow-up: `GET /api/modules/estimate-followup/trigger`, daily) and
  **direct webhook handling** (Missed Call Recovery: synchronous Twilio
  callback). Neither uses a queue today, and both are explicitly allowed to
  keep working exactly as they do — the directive says current automation
  "may remain operational during migration... must not become the
  permanent execution architecture," not "must be replaced now."
- The app is deployed on **Vercel Hobby**, which already caused one real
  production incident: an hourly cron schedule was silently incompatible
  with Hobby's daily-minimum cron interval and took the entire site down
  with 500s until diagnosed (see `docs/FOUNDER_DEPLOYMENT_VALIDATION.md`
  §4A item 6). Any new execution infrastructure decision must not repeat
  that failure mode.
- There is exactly one paying tenant today. Volume is low.

## Decision

Build the durable execution layer as a **Postgres-native job queue**
(`durable_jobs`, migration `016`; `lib/execution/*`) on infrastructure
already in the stack (Supabase + Vercel Cron), not a new vendor.

Mechanics:

- **Enqueue** (`lib/execution/queue.ts::enqueueJob`) — tenant-scoped,
  optional `idempotencyKey` enforced by a unique partial index
  (`(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL`).
- **Claim** (`store.ts::claimBatch`) — a compare-and-swap `UPDATE ...
  WHERE status = 'queued'` per candidate row. This is the reachable
  equivalent of `SELECT ... FOR UPDATE SKIP LOCKED` through `supabase-js`
  (which doesn't expose raw row locking): two concurrent workers can never
  claim the same job, because only one `UPDATE` can win the
  `WHERE status = 'queued'` race per row.
- **Retry/backoff** (`store.ts::fail` / `computeBackoffSeconds`) —
  exponential, capped at 1 hour (60s, 120s, 240s, ... 3600s), tracked via
  `attempts`/`max_attempts`/`next_attempt_at`.
- **Dead-letter** — `attempts >= max_attempts` transitions to
  `status: 'dead_letter'` instead of retrying forever.
- **Processing** — `lib/execution/queue.ts::processDueJobs()`, invoked from
  `app/api/internal/durable-jobs/process/route.ts`, authenticated the same
  way as the existing Estimate Follow-up cron route
  (`Authorization: Bearer $CRON_SECRET`).

## Why not a dedicated queue vendor now

Per the P0 directive's own decision priority (customer reliability >
tenant security > data integrity > architectural longevity > observability
> maintainability > AI-provider independence > **cost efficiency** >
implementation speed > **novelty**, novelty last):

- **No concrete requirement exceeds what a Postgres queue can do at this
  tenant count.** Inngest/Trigger.dev/QStash earn their cost at scale
  (fan-out, step functions, cross-region delivery, dashboards) — none of
  which this app needs yet with one paying tenant and two low-volume
  modules.
- **A new vendor is a new operational dependency** (a new API key, a new
  webhook surface, a new failure mode to diagnose) on a system whose most
  recent real incident was caused by *not fully understanding* the
  execution platform already in use (Vercel Hobby's cron limits). Adding a
  second execution system before the first is fully proven out increases
  risk, not reliability.
- **"Do not introduce new infrastructure merely because it is
  fashionable... every dependency must solve a concrete architectural
  requirement"** — directive §5. Nothing in P0's exit criteria requires
  sub-second delivery, cross-service step orchestration, or a vendor
  dashboard.

## Explicit upgrade trigger

Revisit this ADR when **any** of the following becomes true:

1. Job volume approaches what daily/hourly Vercel Cron polling can no
   longer service with acceptable latency (the directive's own "hundreds →
   thousands → potentially millions" progression) — i.e. this queue's
   claim-batch/poll-interval model starts silently falling behind.
2. A workflow needs sub-minute delivery latency that Vercel Cron's polling
   cadence cannot provide, *and* the Vercel plan cannot be upgraded to
   support the cron frequency needed (see the existing Pro-plan TODO in
   `docs/FOUNDER_DEPLOYMENT_VALIDATION.md` §4A item 6 for the
   Estimate-Follow-up-specific version of this same tradeoff).
3. A workflow needs true multi-step orchestration (fan-out/fan-in, human-
   in-the-loop waits measured in days, cross-service sagas) that a flat job
   queue does not model well.

At that point, re-evaluate Inngest/Trigger.dev/QStash against the
concrete requirement that triggered the revisit — not speculatively.

## Lease model and effect-key hardening (P0.9 Slice B, finding H-02; migration `018`, not yet applied to production)

The claim mechanics above (`WHERE status = 'queued'`) were the ORIGINAL P0.6
design. P0.9 Slice B hardened ownership with a real lease:

- **`lease_token`** (migration `018`) is the actual ownership credential
  for a job's CURRENT claim — a fresh UUID generated on every claim/reclaim
  — distinct from `locked_by` (a diagnostic worker-name label that a
  process can reuse across a restart). `complete()` / `fail()` /
  `renewLease()` all require an EXACT `lease_token` match, not just
  `status = 'running'`.
- **Active-lease expiry is enforced on every transition, not just claim.**
  A matching `lease_token` alone is not sufficient — `lock_expires_at` must
  still be in the future (`lock_expires_at > now()`). A worker whose lease
  has already expired (crashed, or simply ran past `DEFAULT_LEASE_DURATION_SECONDS`,
  300s) cannot complete, fail, or heartbeat-renew that job anymore, even
  with the correct token — only `claimBatch`'s reclaim path can move the
  job forward again, under a brand-new `lease_token`.
- **Reclaim**: a `running` job whose `lock_expires_at` has passed is
  claimable again by any worker, via the same CAS `UPDATE` pattern,
  re-checking `lock_expires_at <= now()` at UPDATE time (not a stale read)
  so a heartbeat that renewed the lease in between is never overridden. A
  reclaim candidate already at `max_attempts` is swept straight to
  `dead_letter` instead of being reclaimed for another doomed attempt.
- **This is an AT-LEAST-ONCE execution guarantee, explicitly NOT
  exactly-once.** A crash between a handler's external effect succeeding
  and this layer recording that success will cause a retry to run the
  handler body again — the lease model guarantees at most one worker holds
  active ownership at a time, it does not and cannot guarantee an external
  side effect (an SMS send, an API call) happens only once.

**`ctx.effectKey`** (`lib/execution/types.ts::computeEffectKey`) is the
runtime-owned, retry-invariant identity a handler MUST use as its own
provider-supported idempotency key (or its own effect ledger) to get real
exactly-once behavior for a consequential external effect — writing a DB
row afterward is not sufficient by itself, and calling a handler twice for
the "same" job is not automatically safe. It is namespaced
`tenant:<tenantId>:job:<jobType>:<idempotency:<key> | id:<jobId>>` —
stable across every claim/reclaim/retry of the same logical job (mutable
fields like `attempts`, lease state, or timestamps never influence it), a
different key for a different tenant even with an identical caller-supplied
`idempotencyKey`, and a different key for a different `jobType` even under
the same tenant + `idempotencyKey`. A handler has no way to influence it —
it's computed exclusively by the runtime from identity fixed at `enqueue()`.

See `lib/execution/lease.pg.test.ts` (P0.9 Slice D, real Postgres proof —
concurrent claims, expired-lease refusal on every transition, reclaim
under a fresh token, stale-token refusal after reclaim, repeated
crash/reclaim converging on `dead_letter`) and `lib/execution/queue.test.ts`
/ `lib/db/crossTableIdempotency.pg.test.ts` for the effect-key and
`durable_jobs` enqueue-idempotency proofs.

## Consequences

- No new environment variables, no new billing relationship, no new
  external dashboard to learn, for P0.
- The queue is not wired into `vercel.json` in P0 — see "Deployment note"
  below. It is fully functional and independently invocable
  (`POST`/`GET /api/internal/durable-jobs/process` with the cron secret);
  wiring a schedule is a deployment step, not a code change.
- No existing module (Missed Call Recovery, Estimate Follow-up) was moved
  onto this queue in P0 — `lib/execution/handlers.ts` registers only a
  `diagnostic.echo` handler. Migrating a real workflow onto durable
  execution is future work, one workflow at a time, per
  `AGENTIC_ROADMAP.md`.

## Deployment note (action for whoever deploys this)

`vercel.json` currently has one cron entry (`estimate-followup/trigger`,
daily). This ADR does **not** add a second entry to it — the previous
Hobby-plan cron incident means that change should be made deliberately by
whoever controls the live Vercel project, after confirming the plan's
current cron-job count limit, not blindly by this PR. Add:

```json
{ "path": "/api/internal/durable-jobs/process", "schedule": "<daily, offset from the existing entry>" }
```

and set `CRON_SECRET` (already required/set for the existing cron) — no
new environment variable is needed. Until that's added, the route can be
invoked manually with the same header for testing.
