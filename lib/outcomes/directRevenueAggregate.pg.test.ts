import { describe, it, expect, afterAll } from "vitest";
import { getPgTestUrl, getPgTestPool, withRollback, insertTenant, insertMembership, setRole } from "../testHarness/pgTestDb";
import { randomUUID } from "crypto";

/**
 * db/migrations/021_direct_revenue_aggregate.sql — DATABASE-LEVEL proof
 * (P1 Sprint 1 founder final-hardening directive on PR #18).
 *
 * Proves, against a REAL Postgres 16 database, not an in-memory
 * re-implementation:
 *   1. public.sum_direct_outcome_value() computes the correct total over
 *      MORE THAN 5000 direct-attribution rows — the exact scenario the
 *      previous bounded-fetch-and-reduce approach (OUTCOME_SUMMARY_LIMIT)
 *      would have silently undercounted.
 *   2. Non-direct rows (assisted/inferred/unknown) and NULL-valued rows
 *      are correctly excluded.
 *   3. The function is genuinely SECURITY INVOKER, not SECURITY DEFINER
 *      (checked directly against pg_proc, not merely asserted from this
 *      migration's own SQL text).
 *   4. Grants: 'anon' has no EXECUTE; 'authenticated' does.
 *   5. Tenant/RLS isolation actually holds end-to-end: an authenticated
 *      user who is a member of a DIFFERENT tenant gets 0, not the real
 *      total, when calling this function with someone else's tenant id —
 *      proving SECURITY INVOKER + outcomes_select_tenant RLS together
 *      actually block cross-tenant reads through this function, not just
 *      through ordinary table access.
 *
 * Gated on DATABASE_URL/TEST_DATABASE_URL — see lib/testHarness/pgTestDb.ts.
 * Never runs against production; skips cleanly (not silently) when unset.
 */
const DESCRIBE = getPgTestUrl() ? describe : describe.skip;

afterAll(async () => {
  if (getPgTestUrl()) await getPgTestPool().end();
});

const DIRECT_ROW_COUNT = 5500;
const DIRECT_ROW_VALUE = "10.00";
const EXPECTED_DIRECT_TOTAL = DIRECT_ROW_COUNT * 10; // 55000

async function seedBulkOutcomes(client: import("pg").PoolClient, tenantId: string) {
  // Single bulk INSERT ... SELECT FROM generate_series — fast even at
  // thousands of rows, and exercises the exact "large real table" shape
  // the aggregate function needs to be correct against.
  await client.query(
    `INSERT INTO public.outcomes (id, tenant_id, outcome_type, outcome_value, attribution_confidence)
     SELECT gen_random_uuid(), $1, 'admin_time_saved', $2::numeric, 'direct'
     FROM generate_series(1, $3)`,
    [tenantId, DIRECT_ROW_VALUE, DIRECT_ROW_COUNT]
  );

  // Non-direct rows that must NOT be counted — different attribution
  // tiers, deliberately given large dollar values so a bug that blended
  // tiers together would be immediately obvious in the total.
  await client.query(
    `INSERT INTO public.outcomes (id, tenant_id, outcome_type, outcome_value, attribution_confidence)
     VALUES
       (gen_random_uuid(), $1, 'admin_time_saved', 9999.99, 'assisted'),
       (gen_random_uuid(), $1, 'admin_time_saved', 9999.99, 'inferred'),
       (gen_random_uuid(), $1, 'admin_time_saved', 9999.99, 'unknown')`,
    [tenantId]
  );

  // A direct row with NO dollar value at all (a real, valid state — not
  // every outcome carries a figure) — must not turn the sum into NULL or
  // be miscounted.
  await client.query(
    `INSERT INTO public.outcomes (id, tenant_id, outcome_type, outcome_value, attribution_confidence)
     VALUES (gen_random_uuid(), $1, 'admin_time_saved', NULL, 'direct')`,
    [tenantId]
  );
}

DESCRIBE("public.sum_direct_outcome_value (migration 021) — real Postgres proof, not skipped", () => {
  it("computes the correct lifetime direct total over >5000 rows, excluding other attribution tiers and NULLs", async () => {
    await withRollback(async (client) => {
      const tenantId = await insertTenant(client);
      await seedBulkOutcomes(client, tenantId);

      const rowCount = await client.query(
        `SELECT count(*)::int AS n FROM public.outcomes WHERE tenant_id = $1 AND attribution_confidence = 'direct'`,
        [tenantId]
      );
      expect(rowCount.rows[0].n).toBeGreaterThan(5000);
      expect(rowCount.rows[0].n).toBe(DIRECT_ROW_COUNT + 1); // + the NULL-valued direct row

      const { rows } = await client.query(`SELECT public.sum_direct_outcome_value($1) AS total`, [tenantId]);
      expect(Number(rows[0].total)).toBe(EXPECTED_DIRECT_TOTAL);

      // Cross-check against a raw, independently-written aggregate query —
      // proves the function isn't doing something subtly different from
      // the obvious correct query.
      const raw = await client.query(
        `SELECT COALESCE(SUM(outcome_value), 0) AS total FROM public.outcomes WHERE tenant_id = $1 AND attribution_confidence = 'direct'`,
        [tenantId]
      );
      expect(Number(rows[0].total)).toBe(Number(raw.rows[0].total));
    });
  });

  it("returns 0, never NULL or an error, for a tenant with zero outcomes", async () => {
    await withRollback(async (client) => {
      const tenantId = await insertTenant(client);
      const { rows } = await client.query(`SELECT public.sum_direct_outcome_value($1) AS total`, [tenantId]);
      expect(Number(rows[0].total)).toBe(0);
    });
  });

  it("is genuinely SECURITY INVOKER, not SECURITY DEFINER (checked against pg_proc directly)", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `SELECT prosecdef FROM pg_proc WHERE proname = 'sum_direct_outcome_value' AND pronamespace = 'public'::regnamespace`
      );
      expect(rows).toHaveLength(1);
      // prosecdef = true means SECURITY DEFINER; false means SECURITY
      // INVOKER (the default, and what this migration explicitly declares).
      expect(rows[0].prosecdef).toBe(false);
    });
  });

  it("grants: anon has no EXECUTE; authenticated does", async () => {
    await withRollback(async (client) => {
      const { rows } = await client.query(
        `SELECT grantee, privilege_type FROM information_schema.routine_privileges
         WHERE routine_name = 'sum_direct_outcome_value' AND routine_schema = 'public'`
      );
      const granteesWithExecute = rows.filter((r) => r.privilege_type === "EXECUTE").map((r) => r.grantee);
      expect(granteesWithExecute).not.toContain("anon");
      expect(granteesWithExecute).toContain("authenticated");
    });
  });

  it("preserves tenant isolation end-to-end: an authenticated member of a DIFFERENT tenant gets 0, never another tenant's real total", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      const tenantB = await insertTenant(client);
      await seedBulkOutcomes(client, tenantA); // tenant A has real direct revenue

      const userB = randomUUID();
      await insertMembership(client, tenantB, userB, "owner"); // userB belongs to tenant B only

      await setRole(client, "authenticated", userB);
      const { rows } = await client.query(`SELECT public.sum_direct_outcome_value($1) AS total`, [tenantA]);
      // SECURITY INVOKER means this query runs as userB, subject to
      // outcomes_select_tenant RLS — userB is not a member of tenant A, so
      // RLS hides every one of tenant A's rows regardless of the
      // p_tenant_id argument. A SECURITY DEFINER version of this function
      // would leak tenant A's real total here; this must not.
      expect(Number(rows[0].total)).toBe(0);
    });
  });

  it("a genuine tenant member sees their own tenant's real total under RLS", async () => {
    await withRollback(async (client) => {
      const tenantA = await insertTenant(client);
      await seedBulkOutcomes(client, tenantA);

      const userA = randomUUID();
      await insertMembership(client, tenantA, userA, "owner");

      await setRole(client, "authenticated", userA);
      const { rows } = await client.query(`SELECT public.sum_direct_outcome_value($1) AS total`, [tenantA]);
      expect(Number(rows[0].total)).toBe(EXPECTED_DIRECT_TOTAL);
    });
  });
});
