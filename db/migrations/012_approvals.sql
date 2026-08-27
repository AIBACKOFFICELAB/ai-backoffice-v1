-- Approvals (P0.4 — Agentic Foundation)
-- Durable record of every action an agent requested that required (or will
-- require) human sign-off, per the four-tier autonomy model documented in
-- docs/AGENT_SECURITY.md: AUTO_EXECUTE / AUTO_EXECUTE_AND_LOG /
-- REQUIRE_APPROVAL / HUMAN_ONLY.

CREATE TABLE IF NOT EXISTS public.approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  agent_run_id uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
  requested_action text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk_level text NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed')),
  requested_by_type text NOT NULL DEFAULT 'agent' CHECK (requested_by_type IN ('agent', 'system')),
  requested_by_id text,
  approver_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text,
  approved_at timestamp with time zone,
  rejected_at timestamp with time zone,
  expires_at timestamp with time zone,
  execution_result jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approvals_tenant_id ON public.approvals (tenant_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON public.approvals (status);
CREATE INDEX IF NOT EXISTS idx_approvals_agent_run_id ON public.approvals (agent_run_id);

ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;

-- Read-only for tenant members. The approve/reject action itself is an
-- application-level operation (a future API route) that must additionally
-- check role = 'owner' before writing — mirrors how every other mutation in
-- this codebase runs through the service-role client with the authorization
-- decision made in application code, not in an RLS UPDATE policy. See
-- docs/AGENT_SECURITY.md.
DROP POLICY IF EXISTS approvals_select_tenant ON public.approvals;
CREATE POLICY approvals_select_tenant ON public.approvals
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));
