-- Outcome + Revenue Attribution Foundation (P0.8 — Agentic Foundation)
-- Generic structure connecting system/agent activity to measurable business
-- results, with an explicit attribution-confidence tier so the eventual
-- dashboard language ("$18,420 recovered") is honest, not invented. See
-- docs/OUTCOME_ATTRIBUTION.md.

CREATE TABLE IF NOT EXISTS public.outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  workflow_id text,
  agent_run_id uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  entity_type text,
  entity_id text,
  outcome_type text NOT NULL CHECK (outcome_type IN (
    'lead_recovered', 'appointment_booked', 'estimate_reengaged', 'estimate_won',
    'revenue_recovered', 'invoice_collected', 'review_generated', 'admin_time_saved', 'other'
  )),
  outcome_value numeric(12,2),
  currency text NOT NULL DEFAULT 'USD',
  attribution_confidence text NOT NULL CHECK (attribution_confidence IN ('direct', 'assisted', 'inferred', 'unknown')),
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outcomes_tenant_id ON public.outcomes (tenant_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_outcome_type ON public.outcomes (outcome_type);
CREATE INDEX IF NOT EXISTS idx_outcomes_occurred_at ON public.outcomes (occurred_at);

ALTER TABLE public.outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outcomes_select_tenant ON public.outcomes;
CREATE POLICY outcomes_select_tenant ON public.outcomes
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));
