-- P1 Sprint 1 — Founder final-hardening directive on PR #18 (Codex P2 finding)
--
-- Closes the "Direct Revenue Recovered by AI" headline-KPI finding on
-- lib/dashboard/revenueCommandCenter.ts: the dashboard was summing a
-- bounded fetch of outcomes (OUTCOME_SUMMARY_LIMIT rows, most-recent-first)
-- client-side, so a tenant whose lifetime DIRECT-attributed outcome count
-- ever exceeded that bound would see the headline figure silently
-- decrease as older direct revenue aged out of the fetch window — a false
-- signal for a metric whose entire point (OUTCOME_ATTRIBUTION.md) is
-- truthfulness. This migration adds the real SUM() aggregate that
-- structural fix needs; lib/outcomes/store.ts and
-- lib/dashboard/revenueCommandCenter.ts are updated in the same commit to
-- call it instead of fetching-and-reducing a bounded row set for this one
-- figure. Activity/history feeds elsewhere keep their own separate,
-- intentional bounds (see RECENT_ACTIVITY_LIMIT/RECENT_RUNS_LIMIT) — this
-- migration does not touch those.
--
-- NOT applied to production as part of this change — see the PR's own
-- founder directive: "DO NOT APPLY MIGRATION 021 TO PRODUCTION." Verified
-- only against a disposable local Postgres 16 with migrations 001-020
-- already applied, including a real >5000-row proof
-- (lib/outcomes/directRevenueAggregate.pg.test.ts).
--
-- SECURITY INVOKER, deliberately, not SECURITY DEFINER: the function must
-- run under the CALLING role's own privileges, so outcomes' existing RLS
-- policy (outcomes_select_tenant, migration 015 — SELECT scoped to
-- public.is_tenant_member(tenant_id)) still applies to whatever role
-- actually calls it. This codebase's application code always calls
-- through the service-role client (which bypasses RLS globally,
-- independent of invoker/definer — see
-- docs/constitution/06_DATABASE_PRINCIPLES.md), so the explicit
-- p_tenant_id filter inside the function body is the operative guarantee
-- for that path, matching the "explicit tenant_id filter in every query"
-- discipline every store in this codebase already follows (see
-- DOMAIN_MODEL.md's "Tenant isolation posture"). SECURITY INVOKER is what
-- makes it also safe to expose to a real 'authenticated' PostgREST caller
-- later without repeating the is_tenant_member() SECURITY DEFINER
-- grant-history incident documented in migration 020's header: a
-- SECURITY DEFINER version of this function would need the same care
-- around anon/authenticated grants that is_tenant_member needed; a
-- SECURITY INVOKER one does not, because RLS is never bypassed by the
-- function's own ownership.
--
-- Lock / deployment note: CREATE OR REPLACE FUNCTION takes no table lock.
-- The new partial covering index (idx_outcomes_tenant_direct_value) is not
-- created CONCURRENTLY — against the current empty/near-empty production
-- outcomes table this is instantaneous; re-evaluate CONCURRENTLY once
-- outcomes holds meaningful row volume in production.
--
-- Rollback note: forward-only numbered migrations, no down-migration
-- tooling (docs/constitution/09_DEVELOPMENT_STANDARDS.md). If this
-- migration must be reverted: `DROP FUNCTION
-- public.sum_direct_outcome_value(uuid);` and `DROP INDEX
-- idx_outcomes_tenant_direct_value;` — safe to drop at any time; nothing
-- in 001-020 depends on either object.

-- =========================================================================
-- 1. Covering partial index for the exact query this function runs —
--    (tenant_id, attribution_confidence) WHERE attribution_confidence =
--    'direct', with outcome_value included so a lookup can be satisfied by
--    an index-only scan without a heap fetch per row.
-- =========================================================================

CREATE INDEX IF NOT EXISTS idx_outcomes_tenant_direct_value
  ON public.outcomes (tenant_id, attribution_confidence)
  INCLUDE (outcome_value)
  WHERE attribution_confidence = 'direct';

-- =========================================================================
-- 2. The aggregate itself — the tenant's full lifetime DIRECT-attribution
--    outcome total, never bounded, never blended with
--    assisted/inferred/unknown (OUTCOME_ATTRIBUTION.md's honesty rule).
--    NULL outcome_value rows (a real, valid state — not every outcome
--    carries a dollar figure) are correctly excluded by SUM() itself, no
--    explicit filter needed; COALESCE only guards against the have-zero-
--    matching-rows case, where SUM() would otherwise return NULL rather
--    than the truthful 0.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.sum_direct_outcome_value(p_tenant_id uuid)
RETURNS numeric(12,2)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(outcome_value), 0)
  FROM public.outcomes
  WHERE tenant_id = p_tenant_id
    AND attribution_confidence = 'direct';
$$;

COMMENT ON FUNCTION public.sum_direct_outcome_value(uuid) IS
  'Lifetime sum of outcomes.outcome_value for a tenant''s direct-attribution-confidence rows only — never bounded, never blended with assisted/inferred/unknown. SECURITY INVOKER: relies on outcomes_select_tenant RLS for any non-service-role caller; the explicit p_tenant_id filter is the operative guarantee for the service-role application path, which bypasses RLS by design. See lib/outcomes/store.ts::SupabaseOutcomeStore.sumDirectAttributionValue and db/migrations/021_direct_revenue_aggregate.sql.';

-- Explicit grants, mirroring the reasoning in migration 020's header for
-- is_tenant_member(): no legitimate reason for an anonymous session to
-- call this (auth.uid() is NULL for anon regardless, so RLS would return
-- zero rows anyway, but there is no reason to expose it as a public RPC
-- surface at all); authenticated keeps EXECUTE since SECURITY INVOKER
-- means RLS still fully applies to what an authenticated caller can see
-- through it. service_role and postgres already have EXECUTE via their
-- elevated role membership; granted explicitly here for clarity, not
-- because it would otherwise be missing.
REVOKE EXECUTE ON FUNCTION public.sum_direct_outcome_value(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sum_direct_outcome_value(uuid) TO authenticated, service_role, postgres;
