# Agent Security — P0.3 / P0.4

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

`evaluateToolCall(agent, { toolName, permission })` is the single entry
point the runtime calls before invoking any tool. Pure function, no I/O —
every decision is reconstructable from the agent row alone.

```
1. agent.status !== 'active'              → deny
2. toolName not in agent.allowed_tools    → deny
3. resolve tier = approval_policy[toolName] ?? 'REQUIRE_APPROVAL'
4. apply the permission floor (below)
5. tier === 'HUMAN_ONLY'                  → deny (never queued for approval)
   tier === 'REQUIRE_APPROVAL'            → require_approval
   else (AUTO_EXECUTE*)                   → allow
```

**Permission floors** (`PERMISSION_FLOOR` in `permissions.ts`) — a
misconfigured `approval_policy` cannot silently grant autonomy the
directive says must be earned:

- `DELETE` → never lower than `REQUIRE_APPROVAL`.
- `FINANCIAL_ACTION` → never lower than `REQUIRE_APPROVAL`.
- `APPROVE` → always `HUMAN_ONLY`. **An agent can never approve its own or
  another agent's action**, regardless of configuration.

See `lib/agents/permissions.test.ts` for the full table of enforced cases,
including the deliberately-misconfigured-policy cases the floor exists for.

## Approvals

`approvals` (migration `012`): `requested_action`, `payload`, `risk_level`,
`status` (`pending`/`approved`/`rejected`/`expired`/`executed`),
`requested_by_type`/`id`, `approver_user_id`, `expires_at`,
`execution_result`.

`lib/approvals/service.ts` is the only write path:

- `requestApproval` — called by the runtime when `evaluateToolCall` returns
  `require_approval`.
- `approveApproval` / `rejectApproval` — **require the caller to pass the
  approver's tenant role**, and refuse outright if it isn't `'owner'`. This
  mirrors how every other mutation in this codebase makes its authorization
  decision in application code, not in an RLS policy (RLS on `approvals` is
  `SELECT`-only for tenant members — see `docs/constitution/06_DATABASE_PRINCIPLES.md`).
  Both also refuse a decision on a non-`'pending'` approval (no
  double-approval) and auto-transition an expired approval to `'expired'`
  instead of allowing it through.

See `lib/approvals/service.test.ts`.

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

`resumeAfterApprovalDecision()` closes the loop: once a human decides a
pending approval, it executes the originally-requested tool call (if
approved) or marks it denied (if rejected), and completes the `agent_run`
once nothing is left outstanding — genuinely resuming from durable state,
not from in-memory continuation (see `lib/agents/runtime.test.ts`).

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

## Tenant isolation

Every table above: `tenant_id NOT NULL`, RLS enabled, `SELECT` policy via
`is_tenant_member()`. Every store in `lib/agents/*` and `lib/approvals/*`
filters by `tenant_id` explicitly in every query (service-role bypasses
RLS — see `docs/constitution/06_DATABASE_PRINCIPLES.md`). Pinned by
`lib/tenantIsolation.test.ts`.
