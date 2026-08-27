-- P0.9 Slice A — Agentic Foundation Hardening
--
-- Remediates the independent Codex P0 acceptance audit findings B-01, and
-- the schema half of B-03 and M-03 (application-layer changes for B-02/B-03
-- live in lib/agents and lib/approvals — see AGENT_SECURITY.md). Migrations
-- 009-016 are historical production migrations and are NOT edited, renamed,
-- squashed, replaced, or reordered by this file — this is a new, additive/
-- corrective migration on top of them.
--
-- NOT applied to production as part of P0.9 Slice A. Verified read-only
-- against the live AIBACKOFFICE Supabase project (yohfpsaemgibarlgodmh)
-- immediately before authoring this file:
--   - business_events, agents, agent_runs, approvals, tool_calls,
--     model_invocations, outcomes, durable_jobs: all 0 rows.
--   - Postgres 17.6 — supports column-scoped `ON DELETE SET NULL (col)` on
--     composite foreign keys (added in PG15), used throughout section 1 so
--     a parent delete nulls only the FK column, never tenant_id (which is
--     NOT NULL on every table below — a bare multi-column SET NULL would
--     otherwise try to null tenant_id too and abort the delete).
--   - Every constraint name referenced in DROP CONSTRAINT below was read
--     from pg_constraint on the live schema, not assumed from convention.
--
-- Lock / deployment note: the ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY
-- statements in section 1 take a brief ACCESS EXCLUSIVE lock on the
-- referencing table while validating. Against the current empty tables this
-- is instantaneous; once real rows exist, apply during a low-traffic window.
--
-- Rollback note: this repo has no down-migration tooling (forward-only
-- numbered migrations, per docs/constitution/09_DEVELOPMENT_STANDARDS.md).
-- If this migration must be reverted: drop each *_tenant_*_fkey constraint
-- added in section 1 and recreate the original single-column FK (defs
-- preserved above/inline as comments); drop the section-1 UNIQUE(tenant_id,
-- id) constraints and indexes; in section 2, drop payload_digest and
-- tool_calls_approval_id_key, and restore the original approvals_status_check
-- (without 'executing'); in section 3, drop uq_agents_tenant_builtin_type.
-- All of the above are safe to drop at any time (no other object depends on
-- them) since this migration adds nothing that anything else in 009-016
-- references.

-- =========================================================================
-- 0. Safety guard for the one column addition that isn't purely additive:
--    payload_digest is NOT NULL with no default (section 2b). Confirmed
--    empty above; this guard makes that assumption loud and explicit rather
--    than implicit, in case this migration is applied later than expected.
-- =========================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.approvals LIMIT 1) THEN
    RAISE EXCEPTION 'migration 017 assumes public.approvals is empty (verified true at authoring time) — a payload_digest backfill strategy is required before applying this migration to a populated table';
  END IF;
END $$;

-- =========================================================================
-- 1. B-01 — tenant-consistent relationships
--
-- Every FK below is upgraded from a single-column reference (which lets a
-- service-role bug attach tenant A's child row to tenant B's parent row,
-- since service-role bypasses RLS) to a composite (tenant_id, id)
-- reference. A tenant-scoped child record can no longer structurally
-- reference another tenant's parent record, regardless of application
-- code correctness.
-- =========================================================================

-- 1a. UNIQUE (tenant_id, id) on every table that becomes a composite-FK
--     target below. Each id is already globally unique via its primary
--     key — this adds no behavior change, it only makes (tenant_id, id) a
--     valid FK target.
ALTER TABLE public.agents ADD CONSTRAINT agents_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE public.business_events ADD CONSTRAINT business_events_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE public.agent_runs ADD CONSTRAINT agent_runs_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE public.approvals ADD CONSTRAINT approvals_tenant_id_id_key UNIQUE (tenant_id, id);

-- 1b. agent_runs.agent_id -> agents
--     was: FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
ALTER TABLE public.agent_runs DROP CONSTRAINT agent_runs_agent_id_fkey;
ALTER TABLE public.agent_runs
  ADD CONSTRAINT agent_runs_tenant_agent_fkey
  FOREIGN KEY (tenant_id, agent_id) REFERENCES public.agents (tenant_id, id) ON DELETE CASCADE;

-- 1c. agent_runs.trigger_event_id -> business_events
--     was: FOREIGN KEY (trigger_event_id) REFERENCES business_events(id) ON DELETE SET NULL
ALTER TABLE public.agent_runs DROP CONSTRAINT agent_runs_trigger_event_id_fkey;
ALTER TABLE public.agent_runs
  ADD CONSTRAINT agent_runs_tenant_trigger_event_fkey
  FOREIGN KEY (tenant_id, trigger_event_id) REFERENCES public.business_events (tenant_id, id)
  ON DELETE SET NULL (trigger_event_id);

-- 1d. approvals.agent_id -> agents
--     was: FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
ALTER TABLE public.approvals DROP CONSTRAINT approvals_agent_id_fkey;
ALTER TABLE public.approvals
  ADD CONSTRAINT approvals_tenant_agent_fkey
  FOREIGN KEY (tenant_id, agent_id) REFERENCES public.agents (tenant_id, id)
  ON DELETE SET NULL (agent_id);

-- 1e. approvals.agent_run_id -> agent_runs
--     was: FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
ALTER TABLE public.approvals DROP CONSTRAINT approvals_agent_run_id_fkey;
ALTER TABLE public.approvals
  ADD CONSTRAINT approvals_tenant_agent_run_fkey
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES public.agent_runs (tenant_id, id)
  ON DELETE SET NULL (agent_run_id);

-- 1f. tool_calls.agent_run_id -> agent_runs (NOT NULL)
--     was: FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
ALTER TABLE public.tool_calls DROP CONSTRAINT tool_calls_agent_run_id_fkey;
ALTER TABLE public.tool_calls
  ADD CONSTRAINT tool_calls_tenant_agent_run_fkey
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES public.agent_runs (tenant_id, id) ON DELETE CASCADE;

-- 1g. tool_calls.approval_id -> approvals
--     was: FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE SET NULL
ALTER TABLE public.tool_calls DROP CONSTRAINT tool_calls_approval_id_fkey;
ALTER TABLE public.tool_calls
  ADD CONSTRAINT tool_calls_tenant_approval_fkey
  FOREIGN KEY (tenant_id, approval_id) REFERENCES public.approvals (tenant_id, id)
  ON DELETE SET NULL (approval_id);

-- 1h. model_invocations.agent_run_id -> agent_runs
--     was: FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
ALTER TABLE public.model_invocations DROP CONSTRAINT model_invocations_agent_run_id_fkey;
ALTER TABLE public.model_invocations
  ADD CONSTRAINT model_invocations_tenant_agent_run_fkey
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES public.agent_runs (tenant_id, id)
  ON DELETE SET NULL (agent_run_id);

-- 1i. outcomes.agent_run_id -> agent_runs
--     was: FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL
ALTER TABLE public.outcomes DROP CONSTRAINT outcomes_agent_run_id_fkey;
ALTER TABLE public.outcomes
  ADD CONSTRAINT outcomes_tenant_agent_run_fkey
  FOREIGN KEY (tenant_id, agent_run_id) REFERENCES public.agent_runs (tenant_id, id)
  ON DELETE SET NULL (agent_run_id);

-- 1j. Indexes for the new composite FK columns. tool_calls.approval_id and
--     outcomes.agent_run_id had NO index at all before this migration
--     (confirmed via pg_indexes on the live schema) — added here. The rest
--     already had a single-column index (kept, unrelated to this fix); a
--     composite (tenant_id, x) index is added alongside it since
--     tenant_id-first is this app's actual query pattern (every repository
--     in lib/ filters by tenant_id first — see docs/constitution/06_DATABASE_PRINCIPLES.md).
CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant_agent_id ON public.agent_runs (tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant_trigger_event_id ON public.agent_runs (tenant_id, trigger_event_id);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_agent_id ON public.approvals (tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant_agent_run_id ON public.approvals (tenant_id, agent_run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tenant_agent_run_id ON public.tool_calls (tenant_id, agent_run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tenant_approval_id ON public.tool_calls (tenant_id, approval_id);
CREATE INDEX IF NOT EXISTS idx_model_invocations_tenant_agent_run_id ON public.model_invocations (tenant_id, agent_run_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_tenant_agent_run_id ON public.outcomes (tenant_id, agent_run_id);

-- =========================================================================
-- 2. B-03 (schema half) — atomic, single-use, payload-bound approval
--    execution. See lib/approvals/store.ts::beginExecution/completeExecution
--    and lib/approvals/payloadBinding.ts for the application-layer state
--    machine this supports.
-- =========================================================================

-- 2a. New status sits between 'approved' and 'executed': an approval that
--     has been claimed for execution but hasn't finished yet. Only one
--     caller's compare-and-swap UPDATE can ever move a given approval from
--     'approved' to 'executing' — see AGENT_SECURITY.md for the documented
--     guarantee (at-most-one-concurrent-executor, not exactly-once).
ALTER TABLE public.approvals DROP CONSTRAINT approvals_status_check;
ALTER TABLE public.approvals
  ADD CONSTRAINT approvals_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executing', 'executed'));

-- 2b. The binding between "what a human approved" and "what actually
--     executes." NOT NULL is safe given the guard in section 0.
ALTER TABLE public.approvals ADD COLUMN payload_digest text NOT NULL;
COMMENT ON COLUMN public.approvals.payload_digest IS
  'SHA-256 hex digest of a canonical {tenantId, agentId, agentRunId, toolName, action, payload} JSON, computed at approval-request time. Execution recomputes this from the approval''s own tenant/agent/run plus the current tool_calls row and refuses to proceed on any mismatch — see lib/approvals/service.ts::beginExecution.';

-- 2c. At most one tool_call may be linked to a given approval — prevents
--     duplicate approval linkage. Postgres unique constraints do not
--     compare NULLs, so tool_calls with no approval (the common case) are
--     unaffected.
ALTER TABLE public.tool_calls ADD CONSTRAINT tool_calls_approval_id_key UNIQUE (approval_id);

-- =========================================================================
-- 3. M-03 — durable identity for built-in/system agents
-- =========================================================================

-- One row per (tenant_id, agent_type) for every type EXCEPT 'custom'.
-- 'custom' stays unbounded per tenant so future bespoke agents are never
-- blocked by this constraint — only the fixed, named roles (dev_test,
-- supervisor, and the reserved specialist types) are singletons per
-- tenant. This is the canonical key lib/agents/seed.ts's idempotent
-- insert-and-catch-conflict relies on (see M-03 in the Codex audit).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_tenant_builtin_type
  ON public.agents (tenant_id, agent_type)
  WHERE agent_type <> 'custom';
