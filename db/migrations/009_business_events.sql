-- Business Event System (P0.5 — Agentic Foundation)
-- Canonical, tenant-scoped event log so modules and the future agent runtime
-- can observe "what happened" without coupling directly to each other.
--
-- This is NOT a replacement for per-module History tables
-- (missed_call_recovery_history, estimate_followup_history, ...). Those stay
-- exactly as documented in docs/constitution/03_MODULE_ARCHITECTURE.md — the
-- business-outcome-facing, customer-visible record of what a module did.
-- business_events is a separate, cross-module orchestration/observability
-- log: what happened anywhere in the system, in a shape the agent runtime
-- can trigger and reconstruct against. See the dated amendment in
-- docs/constitution/06_DATABASE_PRINCIPLES.md and docs/EVENT_SYSTEM.md.

CREATE TABLE IF NOT EXISTS public.business_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_type text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user', 'system', 'agent', 'integration')),
  actor_id text,
  entity_type text,
  entity_id text,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  causation_id uuid,
  idempotency_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Idempotent emission: the same logical event (e.g. a retried Twilio
-- callback, a replayed queue message) must not be recorded twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_events_tenant_idempotency
  ON public.business_events (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_business_events_tenant_id ON public.business_events (tenant_id);
CREATE INDEX IF NOT EXISTS idx_business_events_type ON public.business_events (event_type);
CREATE INDEX IF NOT EXISTS idx_business_events_entity ON public.business_events (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_business_events_correlation_id ON public.business_events (correlation_id);
CREATE INDEX IF NOT EXISTS idx_business_events_occurred_at ON public.business_events (occurred_at);

ALTER TABLE public.business_events ENABLE ROW LEVEL SECURITY;

-- Read-only for tenant members (internal observability). Writes happen
-- exclusively through the service-role server client, matching every other
-- module's History table in this schema (see missed_call_recovery_history).
DROP POLICY IF EXISTS business_events_select_tenant ON public.business_events;
CREATE POLICY business_events_select_tenant ON public.business_events
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));
