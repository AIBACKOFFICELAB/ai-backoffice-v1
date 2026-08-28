import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "crypto";
import {
  getPgTestUrl,
  withRollback,
  setRole,
  insertTenant,
  insertMembership,
  insertAgent,
  insertAgentRun,
  insertApproval,
  insertToolCall,
  insertModelInvocation,
  insertOutcome,
  insertBusinessEvent,
  insertDurableJob,
  getPgTestPool,
} from "../testHarness/pgTestDb";

/**
 * RLS table matrix — DATABASE-LEVEL proof, tested as REAL Postgres roles
 * (P0.9 Slice D, D.9 SECURITY DEFINER re-audit + D.10 RLS matrix). "RLS
 * enabled" alone is never treated as proof of correct isolation here —
 * every row below is exercised by actually running a query AS anon /
 * authenticated (with a simulated auth.uid() via the same
 * request.jwt.claims GUC PostgREST sets) / service_role, per
 * db/shadow_env/000_supabase_scaffold.sql and
 * lib/testHarness/pgTestDb.ts::setRole.
 *
 * Every test below arranges its fixture rows AND switches role, on the
 * SAME client/transaction (via setRole inside one withRollback) — see
 * setRole's own doc comment for why two separate pooled connections would
 * not work here.
 *
 * Gated on DATABASE_URL/TEST_DATABASE_URL — see lib/testHarness/pgTestDb.ts.
 * Never runs against production; skips cleanly (not silently) when unset.
 */
const DESCRIBE = getPgTestUrl() ? describe : describe.skip;

afterAll(async () => {
  if (getPgTestUrl()) await getPgTestPool().end();
});

function pgErrorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null | undefined)?.code;
}

/** The 7 P0.9 agentic-foundation tables that share the IDENTICAL RLS shape:
 * exactly one policy, `FOR SELECT USING (is_tenant_member(tenant_id))` —
 * no INSERT/UPDATE/DELETE policy at all, so those are refused outright for
 * anon/authenticated regardless of tenant membership; writes go only
 * through the service-role server client, matching every module History
 * table's documented posture (see migration 009's comment). */
const SELECT_ONLY_TENANT_TABLES: Array<{
  table: string;
  seed: (client: import("pg").PoolClient, tenantId: string) => Promise<string>;
}> = [
  { table: "business_events", seed: (c, t) => insertBusinessEvent(c, t) },
  { table: "agents", seed: (c, t) => insertAgent(c, t) },
  {
    table: "agent_runs",
    seed: async (c, t) => {
      const agentId = await insertAgent(c, t);
      return insertAgentRun(c, t, agentId);
    },
  },
  {
    table: "approvals",
    seed: async (c, t) => {
      const agentId = await insertAgent(c, t);
      const runId = await insertAgentRun(c, t, agentId);
      return insertApproval(c, t, agentId, runId);
    },
  },
  {
    table: "tool_calls",
    seed: async (c, t) => {
      const agentId = await insertAgent(c, t);
      const runId = await insertAgentRun(c, t, agentId);
      return insertToolCall(c, t, runId);
    },
  },
  {
    table: "model_invocations",
    seed: async (c, t) => {
      const agentId = await insertAgent(c, t);
      const runId = await insertAgentRun(c, t, agentId);
      return insertModelInvocation(c, t, runId);
    },
  },
  {
    table: "outcomes",
    seed: async (c, t) => {
      const agentId = await insertAgent(c, t);
      const runId = await insertAgentRun(c, t, agentId);
      return insertOutcome(c, t, runId);
    },
  },
];

DESCRIBE("RLS table matrix (P0.9 agentic-foundation tables) — tested as real anon/authenticated/service_role Postgres roles", () => {
  for (const { table, seed } of SELECT_ONLY_TENANT_TABLES) {
    it(`${table}: authenticated tenant member can SELECT own tenant's row`, async () => {
      await withRollback(async (client) => {
        const tenantId = await insertTenant(client);
        const userId = randomUUID();
        await insertMembership(client, tenantId, userId);
        await seed(client, tenantId);

        await setRole(client, "authenticated", userId);
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE tenant_id = $1`, [tenantId]);
        expect(rows[0].n).toBe(1);
      });
    });

    it(`${table}: authenticated NON-member of the tenant sees zero rows`, async () => {
      await withRollback(async (client) => {
        const tenantId = await insertTenant(client);
        const outsiderUserId = randomUUID(); // never added as a member of tenantId
        await seed(client, tenantId);

        await setRole(client, "authenticated", outsiderUserId);
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE tenant_id = $1`, [tenantId]);
        expect(rows[0].n).toBe(0);
      });
    });

    it(`${table}: authenticated cannot INSERT — no write policy exists for this table (writes are service-role only)`, async () => {
      await withRollback(async (client) => {
        const tenantId = await insertTenant(client);
        const userId = randomUUID();
        await insertMembership(client, tenantId, userId);

        await setRole(client, "authenticated", userId);
        let err: unknown;
        try {
          await seed(client, tenantId);
        } catch (e) {
          err = e;
        }
        expect(pgErrorCode(err)).toBe("42501"); // insufficient_privilege — RLS: new row violates row-level security policy
      });
    });

    it(`${table}: service_role bypasses RLS entirely — sees the row regardless of tenant membership`, async () => {
      await withRollback(async (client) => {
        const tenantId = await insertTenant(client);
        await seed(client, tenantId);

        await setRole(client, "service_role");
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE tenant_id = $1`, [tenantId]);
        expect(rows[0].n).toBe(1);
      });
    });
  }

  it("durable_jobs: NO RLS policy exists at all — authenticated tenant member still sees zero rows (deny-by-default, service-role only by design)", async () => {
    await withRollback(async (client) => {
      const tenantId = await insertTenant(client);
      const userId = randomUUID();
      await insertMembership(client, tenantId, userId);
      await insertDurableJob(client, tenantId);

      await setRole(client, "authenticated", userId);
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.durable_jobs WHERE tenant_id = $1`, [tenantId]);
      expect(rows[0].n).toBe(0);
    });
  });

  it("durable_jobs: service_role still sees and can act on the row (bypasses RLS entirely, matching every other table)", async () => {
    await withRollback(async (client) => {
      const tenantId = await insertTenant(client);
      await insertDurableJob(client, tenantId);

      await setRole(client, "service_role");
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.durable_jobs WHERE tenant_id = $1`, [tenantId]);
      expect(rows[0].n).toBe(1);
    });
  });

  it("tenant_memberships: a user can SELECT only their OWN membership row, never another user's", async () => {
    await withRollback(async (client) => {
      const tenantId = await insertTenant(client);
      const userA = randomUUID();
      const userB = randomUUID();
      await insertMembership(client, tenantId, userA);
      await insertMembership(client, tenantId, userB);

      await setRole(client, "authenticated", userA);
      const { rows } = await client.query(`SELECT user_id FROM public.tenant_memberships WHERE tenant_id = $1`, [tenantId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(userA);
    });
  });

  it("tenants: a member can SELECT their tenant row; a non-member cannot", async () => {
    await withRollback(async (client) => {
      const tenantId = await insertTenant(client);
      const memberId = randomUUID();
      const outsiderId = randomUUID();
      await insertMembership(client, tenantId, memberId);

      await setRole(client, "authenticated", memberId);
      const asMember = await client.query(`SELECT count(*)::int AS n FROM public.tenants WHERE id = $1`, [tenantId]);
      expect(asMember.rows[0].n).toBe(1);

      await client.query("RESET ROLE");
      await setRole(client, "authenticated", outsiderId);
      const asOutsider = await client.query(`SELECT count(*)::int AS n FROM public.tenants WHERE id = $1`, [tenantId]);
      expect(asOutsider.rows[0].n).toBe(0);
    });
  });
});

/**
 * SECURITY DEFINER re-audit (D.9) — public.is_tenant_member(uuid), tested
 * against the CURRENT grants this session applied via migration 020.
 */
DESCRIBE("public.is_tenant_member SECURITY DEFINER grants (migration 020) — real Postgres proof", () => {
  it("anon can no longer directly call is_tenant_member() as an RPC — EXECUTE was revoked (migration 020)", async () => {
    await withRollback(async (client) => {
      const tenantId = await insertTenant(client);

      await setRole(client, "anon");
      let err: unknown;
      try {
        await client.query(`SELECT public.is_tenant_member($1)`, [tenantId]);
      } catch (e) {
        err = e;
      }
      expect(pgErrorCode(err)).toBe("42501"); // insufficient_privilege
    });
  });

  it("authenticated retains EXECUTE — RLS still functions for real logged-in users (migration 003/007's proven incident, not repeated)", async () => {
    await withRollback(async (client) => {
      const tenantId = await insertTenant(client);
      const userId = randomUUID();
      await insertMembership(client, tenantId, userId);
      await insertBusinessEvent(client, tenantId);

      // If authenticated's EXECUTE grant were ever revoked, this SELECT
      // would fail with 42501 (function permission denied), not just
      // return 0 rows — exactly the migration 003 incident migration 007
      // reverted. Asserting it still returns the real row proves RLS
      // evaluation still works end-to-end for a real logged-in user.
      await setRole(client, "authenticated", userId);
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM public.business_events WHERE tenant_id = $1`, [tenantId]);
      expect(rows[0].n).toBe(1);
    });
  });

  it("anon querying a tenant-scoped table directly now fails closed with a permission error (not a silent 0-row bypass) — still correctly deny-only", async () => {
    await withRollback(async (client) => {
      const tenantId = await insertTenant(client);
      await insertBusinessEvent(client, tenantId);

      await setRole(client, "anon");
      let err: unknown;
      try {
        await client.query(`SELECT * FROM public.business_events WHERE tenant_id = $1`, [tenantId]);
      } catch (e) {
        err = e;
      }
      // The RLS policy still fires for anon (roles: {public} means every
      // role, anon included) and still tries to evaluate
      // is_tenant_member(tenant_id) — which anon can no longer execute
      // post-020, so Postgres raises insufficient_privilege on the
      // function call itself rather than silently returning 0 rows. Either
      // outcome denies anon the data; this asserts which one migration 020
      // actually produces, so a future change to this behavior is caught.
      expect(pgErrorCode(err)).toBe("42501");
    });
  });
});
