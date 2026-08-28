-- P0.9 Slice C — Production Compatibility + Truthful Attribution + Privacy
-- + Model Gateway Safety
--
-- Remediates the schema half of findings C.3 (outcome deduplication) and
-- M-05 (normalized Model Gateway error taxonomy). Migrations 009-018 are
-- historical/reviewed and are NOT edited, renamed, squashed, replaced, or
-- reordered by this file — this is a new, additive/corrective migration on
-- top of them. Every other Slice C finding (H-01 telemetry deadlines, H-03
-- attribution correction, H-05 PII minimization elsewhere, M-01 gateway
-- fail-closed, M-02 authenticated approval identity, M-04 event contracts)
-- is application-layer only and needs no schema change.
--
-- NOT applied to production as part of P0.9 Slice C. Verified read-only
-- against the live AIBACKOFFICE Supabase project (yohfpsaemgibarlgodmh)
-- immediately before authoring this file: outcomes, business_events,
-- tool_calls, approvals, agent_runs all 0 rows; missed_call_recovery_history
-- and leads both have 5 real rows for the live tenant (confirming this
-- migration must not touch either table, and does not). Production is
-- currently on migrations 009-016 only — 017/018/019 are none of them
-- applied there, consistent with the P0.9 directive.
--
-- Lock / deployment note: both ALTER TABLE ADD COLUMN statements below are
-- nullable with no default requiring a table rewrite — against the current
-- (confirmed empty) tables this is instantaneous; both remain safe (a brief
-- ACCESS EXCLUSIVE lock only) even once real rows exist, since neither
-- column is NOT NULL and neither requires a backfill.
--
-- Rollback note: forward-only numbered migrations, no down-migration
-- tooling (docs/constitution/09_DEVELOPMENT_STANDARDS.md). If this
-- migration must be reverted: drop uq_outcomes_tenant_idempotency and the
-- outcomes.idempotency_key column (section 1); drop the
-- model_invocations_error_category_check constraint and the
-- model_invocations.error_category column (section 2). Both are safe to
-- drop at any time — nothing in 009-018 depends on either.

-- =========================================================================
-- 1. C.3 — outcome deduplication / evidence
--
-- A repeated webhook, event replay, retry, or compatibility callback for
-- the SAME logical evidence must not create a duplicate business outcome.
-- Mirrors the identical pattern already used for business_events
-- (migration 009) and durable_jobs (migration 016) exactly: a nullable
-- key, unique only where present, application-layer dedup as the fast
-- path with this index as the actual guarantee. See
-- lib/outcomes/store.ts::SupabaseOutcomeStore.insert.
-- =========================================================================

ALTER TABLE public.outcomes ADD COLUMN idempotency_key text;
COMMENT ON COLUMN public.outcomes.idempotency_key IS
  'Derived from stable EVIDENCE identity, never from current time — e.g. lead-recovered:<leadId>:<evidenceType>:<evidenceId> for a future real lead_recovered outcome. NULL is valid (not every outcome has a stable evidence identity yet). See lib/outcomes/service.ts::recordOutcome.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_outcomes_tenant_idempotency
  ON public.outcomes (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- =========================================================================
-- 2. M-05 — normalized Model Gateway error taxonomy (audit half)
--
-- lib/ai/gateway.ts::normalizeProviderError already sanitizes every
-- provider failure into a fixed AiGatewayErrorCategory before it's
-- persisted (never the raw provider error body) — this column gives that
-- category its own queryable field alongside the existing free-text
-- `error` message, instead of encoding it into that string.
-- =========================================================================

ALTER TABLE public.model_invocations ADD COLUMN error_category text;
ALTER TABLE public.model_invocations
  ADD CONSTRAINT model_invocations_error_category_check
  CHECK (error_category IS NULL OR error_category IN ('timeout', 'provider_unavailable', 'rate_limited', 'authentication', 'invalid_response', 'configuration', 'unknown'));
COMMENT ON COLUMN public.model_invocations.error_category IS
  'Normalized failure category (see lib/ai/types.ts::AiGatewayErrorCategory). NULL on a succeeded invocation.';
