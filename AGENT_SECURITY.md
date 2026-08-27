# Agent Security — P0.3 / P0.4, hardened P0.9 Slice A

*P0.9 Slice A note: this document was updated to match the hardened
implementation — tool security metadata now lives on the tool definition
(not a caller-supplied field), approval execution is now a compare-and-
swap state machine (not a single non-atomic update), and cross-tenant
relationship integrity is enforced by composite foreign keys in migration
`017` (written, reviewed, NOT yet applied to production — see that
migration's header and `docs/adr/` for status). Read this document, not the
original P0 commit's version of it, as current.*

## Identity

Three distinct identity kinds (`lib/agents/types.ts`), because human
authentication alone is insufficient once agents act:

```ts
type UserActor = { type: "user"; userId: string };        // a Supabase auth user
type ServiceActor = { type: "service"; serviceId: string }; // cron, webhooks, internal jobs
type AgentActor = { type: "agent"; agentId: string; tenantId: string }; // always tenant-scoped
```

An agent identity always resolves back to a row in `agents` — there is no
such thing as an anonymous or ambient agent identity. An agent never
inherits the application's own database access; every action it takes goes
through `evaluateToolCall` first (below).

## The agent registry

`agents` (migration `010`): `agent_type`, `status`, `allowed_tools`,
`read_scopes`/`write_scopes`, `approval_policy`, `model_policy`,
`system_instructions`. `agent_type` is constrained to the long-term
Supervisor hierarchy (`supervisor`, `csr_lead_recovery`,
`estimate_closing`, `job_notes`, `proposal`, `reputation`,
`accounts_receivable`, `contractor_communication`) plus `dev_test` and
`custom` — the column names the future roadmap without building it (see
`AGENTIC_ROADMAP.md`). P0 seeds exactly two rows per tenant
(`lib/agents/seed.ts`):

- **`dev_test`** — `status: 'active'`, only ever configured with the
  mock/safe tools in `lib/agents/toolRegistry.ts`. Proves the runtime.
  Never wired to a production trigger, never touches customer data.
- **`supervisor`** — `status: 'inactive'`, no tools. A placeholder proving
  the schema/registry supports the eventual Supervisor Agent. Not a real
  supervisor.

## Permissions

Fine-grained permissions an action is checked against
(`lib/agents/types.ts`): `READ`, `WRITE`, `SEND`, `EXECUTE`, `APPROVE`,
`DELETE`, `FINANCIAL_ACTION`.

## Tool definitions are the security authority (`lib/agents/toolRegistry.ts`)

**A caller never supplies a permission.** Every registered `ToolDefinition`
owns its own security classification — this is what a tool call is
actually authorized against:

```ts
{
  name, version,
  intrinsicPermission: Permission,     // the ONE true permission — never caller-supplied
  effectClass, sideEffectClass,        // audit classification
  requiredReadScopes: string[],
  requiredWriteScopes: string[],
  minimumAutonomyTier: AutonomyTier,   // a per-tool floor, independent of agent.approval_policy
  validateInput(input): {ok, value} | {ok:false, errors},
  idempotent: boolean,
  execute(input, ctx),
}
```

The runtime's `PlannedToolCall` (what a caller supplies) is `{toolName,
action, input}` — nothing else. There is no field anywhere a caller can
set to declare, omit, forge, or downgrade a permission; `evaluateToolCall`
reads `tool.intrinsicPermission` from the *registered* definition, looked
up by `toolName`, never from caller input. See
`lib/agents/permissions.test.ts` ("caller cannot bypass intrinsic tool
policy by relabeling the operation") for the enforced proof, including that
a decoy `permission` key inside a tool's own input payload has no effect —
`evaluateToolCall` doesn't take a payload parameter at all.

`validateInput` also runs before either execution or an approval request is
created — a malformed call fails immediately and never reaches a human or
the tool body.

## The four-tier autonomy model

Every tool an agent might call is graded, per agent, in
`agents.approval_policy` (`{ toolName: tier }`):

| Tier | Meaning |
|---|---|
| `AUTO_EXECUTE` | Low-risk, reversible — runs immediately. |
| `AUTO_EXECUTE_AND_LOG` | Same, but the distinction is documentation-level in P0: **every** tool call is logged to `tool_calls` regardless of tier (see P0.7), so this tier's "and log" guarantee already holds for `AUTO_EXECUTE` too. |
| `REQUIRE_APPROVAL` | Agent drafts/prepares; a human must approve before it executes. |
| `HUMAN_ONLY` | The agent may never execute this, and may never even request approval for it — a human must act directly. |

An action nobody explicitly graded defaults to `REQUIRE_APPROVAL` — an
agent is never silently trusted for something no one rated.

## The policy engine (`lib/agents/permissions.ts`)

`evaluateToolCall(agent, tool)` is the single entry point the runtime calls
before invoking any tool — `tool` is the *registered* `ToolDefinition`,
never a caller-declared shape. Pure function, no I/O — every decision is
reconstructable from the agent row and the tool definition alone.

```
1. agent.status !== 'active'                        → deny
2. tool.name not in agent.allowed_tools              → deny
3. agent missing a required read/write scope         → deny (canRead/canWrite, actually enforced)
4. resolve tier = strictest of:
     a. approval_policy[tool.name] ?? 'REQUIRE_APPROVAL'
     b. PERMISSION_FLOOR[tool.intrinsicPermission]
     c. tool.minimumAutonomyTier
5. tier === 'HUMAN_ONLY'                             → deny (never queued for approval)
   tier === 'REQUIRE_APPROVAL'                       → require_approval
   else (AUTO_EXECUTE*)                               → allow
```

**Permission floors** (`PERMISSION_FLOOR` in `permissions.ts`) — a
misconfigured `approval_policy` cannot silently grant autonomy the
directive says must be earned. Keyed by `tool.intrinsicPermission`, never
by anything a caller supplies:

- `SEND` → never lower than `REQUIRE_APPROVAL`.
- `DELETE` → never lower than `REQUIRE_APPROVAL`.
- `FINANCIAL_ACTION` → never lower than `REQUIRE_APPROVAL`.
- `APPROVE` → always `HUMAN_ONLY`. **An agent can never approve its own or
  another agent's action**, regardless of configuration.

A tool's own `minimumAutonomyTier` is a second, independent floor —
`draft_customer_message` sets `REQUIRE_APPROVAL` directly on the
definition, on top of (redundantly with, deliberately — defense in depth)
its `SEND` permission floor.

`canRead`/`canWrite` check `tool.requiredReadScopes`/`requiredWriteScopes`
against `agent.readScopes`/`writeScopes` (a `"*"` entry satisfies any
scope) — these were unused utility functions before Slice A; they are now
load-bearing in step 3 above.

See `lib/agents/permissions.test.ts` for the full table of enforced cases,
including the deliberately-misconfigured-policy cases the floors exist
for, and the scope-enforcement cases.

## Approvals

`approvals` (migration `012`, hardened by migration `017`):
`requested_action`, `payload`, `payload_digest`, `risk_level`, `status`
(`pending`/`approved`/`rejected`/`expired`/**`executing`**/`executed`),
`requested_by_type`/`id`, `approver_user_id`, `expires_at`,
`execution_result`.

### The human-decision path (`lib/approvals/service.ts`)

- `requestApproval` — called by the runtime when `evaluateToolCall` returns
  `require_approval`. Requires `payloadDigest` (below) on every call.
- `approveApproval` / `rejectApproval` — **require the caller to pass the
  approver's tenant role**, and refuse outright if it isn't `'owner'`. This
  mirrors how every other mutation in this codebase makes its authorization
  decision in application code, not in an RLS policy (RLS on `approvals` is
  `SELECT`-only for tenant members — see `docs/constitution/06_DATABASE_PRINCIPLES.md`).
  Both call `store.decide()`, which is itself an atomic CAS —
  `WHERE tenant_id = ? AND id = ? AND status = 'pending'` — so any
  `getById()` these functions perform first (to build a friendly error, or
  to check `expiresAt`) is diagnostic-only and never what decides whether
  the transition happens. Concurrent approve+approve, approve+reject, or
  reject+reject on the same approval can only ever have one winner; every
  loser gets a clear "already decided" error, never a silent overwrite. An
  expired-but-still-pending approval auto-transitions to `'expired'`
  (itself via the same CAS) instead of allowing an approve through.

### The execution path (`lib/approvals/store.ts`, `lib/agents/runtime.ts`) — P0.9 Slice A

Approved is not the same as executed. Execution is a separate, atomic,
single-use claim:

```
pending → approved → executing → executed
              ↘ rejected / expired (from pending)
```

- **`beginExecution(tenantId, id, expectedPayloadDigest)`** — one
  conditional `UPDATE ... WHERE status = 'approved' AND payload_digest =
  $digest`. Two concurrent callers can never both succeed (compare-and-
  swap on `status`); a caller whose recomputed digest doesn't match
  (payload mutated since approval — see below) can never succeed either.
  Returns `null` on any failure to claim; the caller must not use a
  follow-up read to decide whether to proceed — only to build a clearer
  error message after the fact.
- **`completeExecution(tenantId, id, executionResult)`** — `executing →
  executed`, always, whether the underlying tool succeeded or failed (the
  outcome is in `execution_result`). This is a **terminal, single-use**
  transition, not a retry loop back to `approved` — retrying a failed
  action requires a **new** approval request.

**Payload binding** (`lib/approvals/payloadBinding.ts`): `payload_digest`
is a SHA-256 hex digest over a canonical `{tenantId, agentId, agentRunId,
toolName, action, payload}`, computed once when the approval is requested
and recomputed at execution time from the approval's own stored identity
plus the *current* `tool_calls` row. Any mutation to
`tool_calls.request_summary` between those two points — or any mismatch in
tenant/agent/run/tool/action — changes the recomputed digest, and
`beginExecution`'s predicate simply never matches. This is what stops
*"approval UI reviews payload A, tool executes modified payload B."*

**The actual guarantee, stated plainly:** at-most-one-concurrent-executor +
single-use + payload-bound. **Not** exactly-once delivery to the tool
itself — a tool execution that fails after the CAS is won still lands on
`executed` (terminal), not a second automatic attempt. This is safe today
because every registered tool (`lib/agents/toolRegistry.ts`) is mock/safe
with no external side effect; a future tool with a real external side
effect must be idempotent on its own terms (`ToolDefinition.idempotent`
exists for this — P0.9 Slice A does not yet wire retry-with-idempotency-key
behavior on top of it, that's a P1 concern once a real tool needs it).

See `lib/approvals/service.test.ts` (human-decision path) and
`lib/approvals/execution.test.ts` + `lib/agents/runtime.test.ts`'s
"approval safety" suite (CAS/digest/duplicate-resume/wrong-state paths).

## Runtime + observability (P0.7)

`lib/agents/runtime.ts::runAgent()`:

1. Loads the agent (context).
2. Creates an `agent_runs` row, `status: 'running'`.
3. Calls `ai.reason()` — the Model Gateway leg. A failure here marks the
   run `'failed'` with `failure_reason` and stops; it never fakes success.
4. For each planned tool call: `evaluateToolCall` → creates a `tool_calls`
   row (always, regardless of decision) → executes / requests approval /
   denies accordingly.
5. Final `agent_runs.status`: `'awaiting_approval'` if anything is still
   pending approval, else `'failed'` if any tool failed, else `'succeeded'`.

`resumeAfterApprovalDecision()` closes the loop once a human decides a
pending approval:

- **approved** → attempts the `beginExecution` CAS (above). A failed claim
  is handled according to *why* it failed, not treated uniformly:
  - **benign race** — another executor already owns (`executing`) or has
    already consumed (`executed`) this approval. Expected under
    concurrency, not a fault: the tool_call is read back fresh and
    returned **unchanged** — never overwritten with `failed`. This is the
    fix for a real defect an independent review caught: the original
    implementation marked the tool_call `failed` unconditionally on any
    lost claim, which could corrupt a call the legitimate winner was still
    executing (or had already completed successfully).
  - **integrity failure** — the payload no longer matches what was
    approved, or the tool is no longer registered. This *does* mark the
    tool_call `failed`, with a reason that never reads like "another
    executor" — `lib/agents/runtime.ts::diagnoseExecutionRefusal` returns
    a `{kind: "benign_race" | "integrity_failure", reason}` and the caller
    branches on `kind`, not on the presence of a reason string.
- **rejected/expired** → marks the tool call `denied`, but only if it
  isn't already in a terminal state — a duplicate resume call on an
  already-resolved tool call is a safe no-op, not a re-mutation.
- **pending** → safe no-op: returns the tool call's current state
  unchanged (the human hasn't decided yet). This, together with the
  benign-race case above, is what makes a duplicate or premature resume
  call (a caller bug, or a genuine race) harmless.

The `agent_run` completes once nothing is left outstanding — genuinely
resuming from durable state, not from in-memory continuation (see
`lib/agents/runtime.test.ts`'s "approval safety" suite).

Deliberately **not** an autonomous tool-use loop: the model is asked to
reason once per run (proving "Model Gateway invoked" in the P0 exit
criteria); which tools actually run is a plan the *caller* declares.
Parsing tool selection out of the model's own response is real
intelligence — that's P1 (an actual Estimate Closing Agent etc.), once an
agent has a reason to need it. P0 proves the plumbing; it does not fake
autonomy.

## Sensitive data

`agent_runs.input_context_ref` is a pointer, not raw context — the schema
deliberately does not have an `input_context` JSONB blob. Populate it with
a reference (a lead id, a conversation id) once a real agent needs input
context; never copy full customer records into an audit log.

## Built-in agent identity (P0.9 Slice A — Codex audit finding M-03)

`lib/agents/seed.ts` no longer does list-then-insert (a real race: two
concurrent seed calls could both pass the "does it exist" check before
either inserted). `AgentStore.createIfAbsent` relies on a database
uniqueness constraint — migration `017`'s partial unique index
`uq_agents_tenant_builtin_type` on `(tenant_id, agent_type) WHERE
agent_type <> 'custom'` — as the actual guarantee: attempt the insert,
and on a unique-violation, read back the row that won. `'custom'` is
excluded from the constraint so a tenant can still have unlimited
bespoke agents; every named/built-in role (`dev_test`, `supervisor`, and
the reserved specialist types) is a singleton per tenant. See
`lib/agents/seed.test.ts`.

## Tenant isolation

Two independent layers, not one:

1. **Application-level filtering** (in production today): every table has
   `tenant_id NOT NULL`, RLS enabled, `SELECT` policy via
   `is_tenant_member()`. Every store in `lib/agents/*` and
   `lib/approvals/*` filters by `tenant_id` explicitly in every query
   (service-role bypasses RLS — see
   `docs/constitution/06_DATABASE_PRINCIPLES.md`). Pinned by
   `lib/tenantIsolation.test.ts`. This layer does **not** protect against a
   bug in that same application code writing a syntactically valid but
   cross-tenant row (e.g. `tool_calls.tenant_id = A` while
   `tool_calls.agent_run_id` actually belongs to tenant B) — the filtering
   is correct only if the code that constructs the row is correct.
2. **Database-level structural enforcement** (Codex P0 audit finding B-01;
   written, reviewed, **NOT yet applied to production** — see migration
   `017`'s header and `docs/adr/` for status): composite foreign keys
   `(tenant_id, x) REFERENCES parent (tenant_id, id)` on every
   agent_runs→agents, agent_runs→business_events, approvals→agents,
   approvals→agent_runs, tool_calls→agent_runs, tool_calls→approvals,
   model_invocations→agent_runs, and outcomes→agent_runs relationship.
   This is the layer that catches the case layer 1 can't: a row is
   rejected outright if its `tenant_id` doesn't match its parent's, even
   from service-role code, even from a bug nobody anticipated. **This
   layer is designed and migration-ready but not yet live** — do not claim
   tenant integrity is structurally guaranteed until migration `017` is
   applied; today it is enforced by layer 1 only. See
   `lib/tenantConsistency.pg.test.ts` for the (currently skipped, not
   executed) test suite that will prove layer 2 once it's applied
   somewhere with a real Postgres connection.
