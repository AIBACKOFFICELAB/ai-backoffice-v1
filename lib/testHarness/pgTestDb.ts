/**
 * Real-Postgres DB integration test harness (P0.9 Slice D).
 *
 * Every `*.pg.test.ts` file in this repo imports from here rather than
 * standing up its own connection logic. The whole point of Slice D is that
 * these tests run against ACTUAL PostgreSQL — not an in-memory
 * re-implementation, which cannot prove a database-enforced constraint
 * without being circular (see the STATUS comments this file's callers
 * replace). Gated on an environment variable so:
 *
 *   DATABASE_URL (or TEST_DATABASE_URL) set, pointing at a disposable
 *   Postgres with db/migrations/001-020 applied -> every *.pg.test.ts
 *   suite executes for real.
 *
 *   neither set -> every *.pg.test.ts suite is cleanly `describe.skip`'d,
 *   with a message naming exactly what's missing. This is NOT the same as
 *   passing — see docs/DB_SCHEMA.md "Running the database integration
 *   suite" and the Slice D completion report's honest test-count breakdown.
 *
 * NEVER points at the production AIBACKOFFICE Supabase project — nothing
 * in this file or its callers has any awareness of that project's
 * credentials; only whatever connection string the environment supplies.
 * Do not set DATABASE_URL to a production connection string when running
 * this suite.
 */
import { Pool, PoolClient } from "pg";
import { randomUUID } from "crypto";

export function getPgTestUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
}

let sharedPool: Pool | null = null;

/** Lazily-created, process-wide pool — every *.pg.test.ts file shares one
 * pool rather than opening a fresh one per file, so a full suite run stays
 * within a small, predictable connection count. */
export function getPgTestPool(): Pool {
  const url = getPgTestUrl();
  if (!url) throw new Error("getPgTestPool() called without DATABASE_URL/TEST_DATABASE_URL set — callers must gate on getPgTestUrl() first");
  if (!sharedPool) sharedPool = new Pool({ connectionString: url, max: 10 });
  return sharedPool;
}

/**
 * Runs `fn` inside a transaction that is always rolled back — the standard
 * pattern for a DB test that must leave no trace regardless of pass/fail.
 * Use this for anything that doesn't itself need to test cross-transaction
 * concurrency (which needs its own real, separate connections/transactions
 * — see runConcurrently below).
 */
export async function withRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPgTestPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    return result;
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/**
 * Switches the CURRENT client's effective role (anon / authenticated /
 * service_role / postgres) for the rest of the enclosing transaction, and
 * optionally simulates a specific authenticated user by setting the same
 * `request.jwt.claims` session GUC PostgREST sets from a caller's verified
 * JWT — see db/shadow_env/000_supabase_scaffold.sql's auth.uid()
 * definition, which reads exactly this GUC, matching Supabase's own real
 * implementation.
 *
 * Deliberately operates on an ALREADY-OPEN client/transaction (passed in by
 * the caller — see withRollback) rather than opening a fresh pooled
 * connection: two different physical connections cannot see each other's
 * uncommitted writes, so a test that arranges fixture rows on one
 * connection and then switches role on a SEPARATE connection would see
 * nothing at all regardless of RLS — not a meaningful RLS proof. Setting up
 * fixtures as the (superuser) pool owner and then `SET LOCAL ROLE`-ing
 * mid-transaction, on the SAME client, is the correct pattern: RLS is
 * re-evaluated per-query against the CURRENT role regardless of which role
 * originally wrote a row, so this still genuinely exercises RLS.
 * `SET LOCAL` is transaction-scoped, so it never leaks onto a pooled
 * connection reused by a later, unrelated test once this one rolls back.
 */
export async function setRole(client: PoolClient, role: "anon" | "authenticated" | "service_role" | "postgres", jwtSub: string | null = null): Promise<void> {
  if (role !== "postgres") await client.query(`SET LOCAL ROLE ${role}`);
  // set_config's third argument (is_local=true) is the SET LOCAL
  // equivalent for a GUC — unlike a plain `SET`, `set_config` accepts a
  // bound parameter, avoiding manual string-escaping of the JSON value.
  if (jwtSub) await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: jwtSub })]);
}

/** Runs several async operations truly concurrently against SEPARATE
 * physical connections/transactions — required for a genuine PostgreSQL
 * race proof (two callers each holding their own transaction), which a
 * single shared client/transaction cannot exercise. Each function receives
 * its own dedicated client (already connected) and is responsible for its
 * own BEGIN/COMMIT/ROLLBACK — concurrency tests need full control over
 * transaction boundaries to interleave them meaningfully. */
export async function runConcurrently<T>(fns: Array<(client: PoolClient) => Promise<T>>): Promise<Array<{ status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }>> {
  const pool = getPgTestPool();
  const clients = await Promise.all(fns.map(() => pool.connect()));
  try {
    const results = await Promise.allSettled(fns.map((fn, i) => fn(clients[i])));
    return results;
  } finally {
    // A caller function that throws (e.g. the deliberately-expected losing
    // side of a unique-violation race) very likely leaves its own BEGIN
    // still open in an ABORTED state — Postgres refuses every further
    // statement on that connection ("current transaction is aborted")
    // until an explicit ROLLBACK. Releasing an aborted connection straight
    // back to the pool without rolling back first corrupts it for
    // whichever caller (this test's own cleanup included) gets it next.
    // Harmless no-op if the transaction already committed or was never
    // opened.
    for (const c of clients) {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Minimal row-creation helpers — enough columns to satisfy NOT NULL/FK
// constraints, nothing more. Each returns the generated id(s). All INSERTs
// run on the caller-supplied client so they participate in that client's
// transaction (and roll back with it under withRollback/withRoleRollback).
// ---------------------------------------------------------------------------

export async function insertTenant(client: PoolClient, overrides: { name?: string; slug?: string } = {}): Promise<string> {
  const id = randomUUID();
  const slug = overrides.slug ?? `tenant-${id}`;
  await client.query(`INSERT INTO public.tenants (id, name, slug) VALUES ($1, $2, $3)`, [id, overrides.name ?? "Test Tenant", slug]);
  return id;
}

export async function insertMembership(client: PoolClient, tenantId: string, userId: string, role: "owner" | "staff" = "owner"): Promise<void> {
  await client.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [userId]);
  await client.query(`INSERT INTO public.tenant_memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)`, [tenantId, userId, role]);
}

export async function insertAgent(client: PoolClient, tenantId: string, overrides: { agentType?: string; name?: string } = {}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.agents (id, tenant_id, agent_type, name, status, allowed_tools, approval_policy)
     VALUES ($1, $2, $3, $4, 'active', '{}', '{}')`,
    [id, tenantId, overrides.agentType ?? "dev_test", overrides.name ?? "Test Agent"]
  );
  return id;
}

export async function insertAgentRun(client: PoolClient, tenantId: string, agentId: string, overrides: { triggerEventId?: string | null; status?: string } = {}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.agent_runs (id, tenant_id, agent_id, trigger_event_id, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, tenantId, agentId, overrides.triggerEventId ?? null, overrides.status ?? "running"]
  );
  return id;
}

export async function insertApproval(client: PoolClient, tenantId: string, agentId: string, agentRunId: string, overrides: { status?: string; payloadDigest?: string } = {}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.approvals (id, tenant_id, agent_id, agent_run_id, requested_action, payload, status, payload_digest)
     VALUES ($1, $2, $3, $4, 'test.action', '{}'::jsonb, $5, $6)`,
    [id, tenantId, agentId, agentRunId, overrides.status ?? "pending", overrides.payloadDigest ?? "test-digest"]
  );
  return id;
}

export async function insertToolCall(client: PoolClient, tenantId: string, agentRunId: string, overrides: { approvalId?: string | null; status?: string } = {}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.tool_calls (id, tenant_id, agent_run_id, tool_name, action, request_summary, status, policy_snapshot, approval_id)
     VALUES ($1, $2, $3, 'ping', 'execute', '{}'::jsonb, $4, '{}'::jsonb, $5)`,
    [id, tenantId, agentRunId, overrides.status ?? "pending", overrides.approvalId ?? null]
  );
  return id;
}

export async function insertBusinessEvent(client: PoolClient, tenantId: string, overrides: { eventType?: string; idempotencyKey?: string | null; correlationId?: string; causationId?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.business_events (id, tenant_id, event_type, idempotency_key, correlation_id, causation_id)
     VALUES ($1, $2, $3, $4, COALESCE($5, gen_random_uuid()), $6)`,
    [id, tenantId, overrides.eventType ?? "test.event", overrides.idempotencyKey ?? null, overrides.correlationId ?? null, overrides.causationId ?? null]
  );
  return id;
}

export async function insertModelInvocation(client: PoolClient, tenantId: string, agentRunId: string | null): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.model_invocations (id, tenant_id, agent_run_id, task_type, provider, model, status)
     VALUES ($1, $2, $3, 'reason', 'mock', 'mock-model', 'succeeded')`,
    [id, tenantId, agentRunId]
  );
  return id;
}

export async function insertOutcome(client: PoolClient, tenantId: string, agentRunId: string | null): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.outcomes (id, tenant_id, agent_run_id, outcome_type, attribution_confidence)
     VALUES ($1, $2, $3, 'admin_time_saved', 'direct')`,
    [id, tenantId, agentRunId]
  );
  return id;
}

export async function insertDurableJob(client: PoolClient, tenantId: string, overrides: { jobType?: string; idempotencyKey?: string | null; status?: string } = {}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO public.durable_jobs (id, tenant_id, job_type, payload, status, idempotency_key)
     VALUES ($1, $2, $3, '{}'::jsonb, $4, $5)`,
    [id, tenantId, overrides.jobType ?? "test.job", overrides.status ?? "queued", overrides.idempotencyKey ?? null]
  );
  return id;
}
