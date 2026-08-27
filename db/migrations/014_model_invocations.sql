-- Model Invocations (P0.2 — Agentic Foundation)
-- Persists routing metadata and outcome for every call made through the
-- provider-neutral model gateway (lib/ai/gateway.ts). agent_run_id is
-- nullable because the gateway is usable outside the agent runtime (e.g. a
-- future one-off "draft this" call) — when it IS called from within a run,
-- the runtime always passes agent_run_id through for full traceability.

CREATE TABLE IF NOT EXISTS public.model_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_run_id uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  task_type text NOT NULL CHECK (task_type IN ('generate', 'reason', 'classify', 'extract', 'summarize', 'embed')),
  provider text NOT NULL,
  model text NOT NULL,
  complexity text,
  latency_preference text,
  cost_preference text,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  estimated_cost_usd numeric(10,6),
  status text NOT NULL DEFAULT 'succeeded' CHECK (status IN ('succeeded', 'failed')),
  error text,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_model_invocations_tenant_id ON public.model_invocations (tenant_id);
CREATE INDEX IF NOT EXISTS idx_model_invocations_agent_run_id ON public.model_invocations (agent_run_id);
CREATE INDEX IF NOT EXISTS idx_model_invocations_provider_model ON public.model_invocations (provider, model);

ALTER TABLE public.model_invocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS model_invocations_select_tenant ON public.model_invocations;
CREATE POLICY model_invocations_select_tenant ON public.model_invocations
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));
