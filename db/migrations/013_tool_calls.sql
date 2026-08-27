-- Tool Calls (P0.7 — Agentic Foundation)
-- Every tool a running agent invokes, its request/response summary, and
-- whether it required approval. See docs/ARCHITECTURE.md for the target
-- Business Event -> Agent Run -> Model Invocation -> Tool Call(s) ->
-- Approval(s) -> Execution Result -> Business Outcome chain.

CREATE TABLE IF NOT EXISTS public.tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_run_id uuid NOT NULL REFERENCES public.agent_runs(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  action text NOT NULL,
  request_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_summary jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'requires_approval', 'denied')),
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  error text,
  requires_approval boolean NOT NULL DEFAULT false,
  approval_id uuid REFERENCES public.approvals(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_tenant_id ON public.tool_calls (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent_run_id ON public.tool_calls (agent_run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON public.tool_calls (status);

ALTER TABLE public.tool_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tool_calls_select_tenant ON public.tool_calls;
CREATE POLICY tool_calls_select_tenant ON public.tool_calls
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));
