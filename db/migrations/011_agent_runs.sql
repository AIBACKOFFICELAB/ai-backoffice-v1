-- Agent Runs (P0.7 — Agentic Foundation)
-- One row per invocation of an agent: the reconstructable spine that ties a
-- trigger event to model invocations, tool calls, approvals, and outcomes.
-- See the target relationship chain in docs/ARCHITECTURE.md.

CREATE TABLE IF NOT EXISTS public.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  trigger_event_id uuid REFERENCES public.business_events(id) ON DELETE SET NULL,
  workflow_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'awaiting_approval', 'succeeded', 'failed', 'cancelled'
  )),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  model_strategy jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Pointer to input context, not the raw context itself — see
  -- docs/AGENT_SECURITY.md "Sensitive data" and P0.7 in the directive.
  input_context_ref text,
  output_summary text,
  failure_reason text,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant_id ON public.agent_runs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id ON public.agent_runs (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON public.agent_runs (status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_correlation_id ON public.agent_runs (correlation_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_trigger_event_id ON public.agent_runs (trigger_event_id);

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_runs_select_tenant ON public.agent_runs;
CREATE POLICY agent_runs_select_tenant ON public.agent_runs
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));
