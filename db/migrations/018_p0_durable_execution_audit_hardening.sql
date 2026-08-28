-- P0.9 Slice B — Durable Execution + Truthful Audit Hardening
--
-- Remediates the independent Codex P0 acceptance audit findings H-02 and
-- H-04 (schema half — application-layer changes live in lib/execution and
-- lib/agents; see AGENT_SECURITY.md and lib/execution/types.ts). Migrations
-- 009-017 are historical/reviewed and are NOT edited, renamed, squashed,
-- replaced, or reordered by this file — this is a new, additive/corrective
-- migration on top of them. The documented deployment order is
-- 009 -> ... -> 017 -> 018; nothing in this file depends on 017 having run
-- first (017 never touches any object this migration modifies), but the
-- migration numbering itself assumes that sequence.
--
-- NOT applied to production as part of P0.9 Slice B. Verified read-only
-- against the live AIBACKOFFICE Supabase project (yohfpsaemgibarlgodmh)
-- immediately before authoring this file:
--   - durable_jobs, tool_calls, agent_runs, approvals: all 0 rows.
--   - agent_runs_status_check, tool_calls_status_check,
--     durable_jobs_status_check: exact names confirmed via pg_constraint,
--     not assumed from convention. Production is currently on migrations
--     009-016 only — 017 is not yet applied there either, consistent with
--     the P0.9 directive that neither 017 nor 018 touches production.
--
-- Lock / deployment note: the two ADD COLUMN statements below (sections 1
-- and 2) and the CHECK-constraint replacement (section 3) each take a
-- brief ACCESS EXCLUSIVE lock on their table. Against the current empty
-- tables this is instantaneous; once real rows exist, apply during a
-- low-traffic window. The new partial index in section 1 is not created
-- CONCURRENTLY, for the same reason — re-evaluate that choice if this
-- migration is ever applied to a populated durable_jobs table.
--
-- Rollback note: forward-only numbered migrations, no down-migration
-- tooling (docs/constitution/09_DEVELOPMENT_STANDARDS.md). If this
-- migration must be reverted: drop idx_durable_jobs_reclaim and the
-- lease_token column (section 1); drop the policy_snapshot column
-- (section 2); restore the original agent_runs_status_check without
-- 'denied'/'partial' (section 3). All three are safe to drop at any time —
-- nothing in 009-017 depends on any object this migration adds.

-- =========================================================================
-- 0. Safety guard for the one column addition that isn't purely additive:
--    tool_calls.policy_snapshot is NOT NULL with no default (section 2).
--    Confirmed empty above; this guard makes that assumption loud and
--    explicit rather than implicit, in case this migration is applied
--    later than expected (same pattern as migration 017 section 0).
-- =========================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tool_calls LIMIT 1) THEN
    RAISE EXCEPTION 'migration 018 assumes public.tool_calls is empty (verified true at authoring time) — a policy_snapshot backfill strategy is required before applying this migration to a populated table';
  END IF;
END $$;

-- =========================================================================
-- 1. H-02 / B.1-B.4 — durable job lease model
--
-- lease_token is the actual ownership credential for a job's CURRENT
-- claim — distinct from locked_by (a diagnostic worker identifier that can
-- be reused across a process restart) so a stale executor can never
-- complete/fail/heartbeat a lease that has since been superseded, even by
-- a worker sharing its old locked_by value. See
-- lib/execution/store.ts::claimBatch/complete/fail/renewLease.
-- =========================================================================

ALTER TABLE public.durable_jobs ADD COLUMN lease_token uuid;
COMMENT ON COLUMN public.durable_jobs.lease_token IS
  'Ownership credential for the CURRENT lease on this job. Freshly generated on every claim/reclaim; complete()/fail()/renewLease() all require an exact match in addition to status=''running''. NULL when the job has never been claimed. See lib/execution/store.ts.';

-- Supports claimBatch's reclaim scan (status='running' AND
-- lock_expires_at <= now()) — the existing idx_durable_jobs_claim
-- (status, next_attempt_at) does not help this branch, since
-- next_attempt_at is irrelevant while a job is running.
CREATE INDEX IF NOT EXISTS idx_durable_jobs_reclaim ON public.durable_jobs (lock_expires_at) WHERE status = 'running';

-- =========================================================================
-- 2. H-04 / B-08 — immutable policy-decision audit
--
-- Set exactly once, at tool_call creation, by
-- lib/agents/permissions.ts::buildPolicySnapshot; structurally excluded
-- from UpdateToolCallInput (lib/agents/toolCallStore.ts) so nothing in
-- application code can mutate it afterward. Lets an auditor reconstruct WHY
-- a tool call was permitted/denied/gated even after the agent's or tool's
-- CURRENT configuration has since changed — reconstructing history must
-- read this column, never live agent/tool config.
-- =========================================================================

ALTER TABLE public.tool_calls ADD COLUMN policy_snapshot jsonb NOT NULL;
COMMENT ON COLUMN public.tool_calls.policy_snapshot IS
  'Immutable snapshot of the policy decision made at evaluation time: requested tool/action, intrinsic permission, resolved autonomy tier, decision, reason, agent instructions version, tool definition version, and relevant scopes. Never updated after INSERT — application code (lib/agents/toolCallStore.ts::UpdateToolCallInput) structurally excludes it from any update path. See lib/agents/permissions.ts::PolicySnapshot/buildPolicySnapshot.';

-- =========================================================================
-- 3. H-04 / B-07 — truthful agent-run terminal status
--
-- Adds 'denied' (every tool call that reached a terminal outcome was denied
-- by policy or rejected by a human approver — no consequential action of
-- this run's actually happened) and 'partial' (a mix of at least one
-- succeeded and at least one denied/rejected outcome, with no outright
-- execution failure) alongside the existing terminal statuses. A run whose
-- requested operation was entirely denied/rejected can no longer be
-- recorded as 'succeeded'. See lib/agents/runStatus.ts::computeRunStatus
-- for the single centralized place this decision is computed.
-- =========================================================================

ALTER TABLE public.agent_runs DROP CONSTRAINT agent_runs_status_check;
ALTER TABLE public.agent_runs
  ADD CONSTRAINT agent_runs_status_check
  CHECK (status IN ('pending', 'running', 'awaiting_approval', 'succeeded', 'failed', 'denied', 'partial', 'cancelled'));
