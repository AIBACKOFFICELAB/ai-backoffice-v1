-- Agent Registry (P0.3 / P0.4 — Agentic Foundation)
-- First-class representation of an AI BackOffice agent: identity, scope,
-- allowed tools/read/write, approval policy, and model policy. This table
-- describes what an agent IS; enforcement of what it's actually allowed to
-- do at runtime lives in lib/agents/permissions.ts (see docs/AGENT_SECURITY.md).
--
-- agent_type is deliberately constrained (not free text) so the eventual
-- Supervisor hierarchy from the P0 directive is visible in the schema from
-- day one, without any of those agents being built yet — P0 ships only
-- 'dev_test' and 'supervisor' rows (see lib/agents/seed.ts).

CREATE TABLE IF NOT EXISTS public.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  agent_type text NOT NULL CHECK (agent_type IN (
    'supervisor', 'dev_test', 'csr_lead_recovery', 'estimate_closing',
    'job_notes', 'proposal', 'reputation', 'accounts_receivable',
    'contractor_communication', 'custom'
  )),
  name text NOT NULL,
  purpose text,
  status text NOT NULL DEFAULT 'inactive' CHECK (status IN ('inactive', 'active', 'paused', 'archived')),
  allowed_tools text[] NOT NULL DEFAULT '{}',
  read_scopes text[] NOT NULL DEFAULT '{}',
  write_scopes text[] NOT NULL DEFAULT '{}',
  -- action key -> 'AUTO_EXECUTE' | 'AUTO_EXECUTE_AND_LOG' | 'REQUIRE_APPROVAL' | 'HUMAN_ONLY'
  approval_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- routing preferences consumed by lib/ai/router.ts, e.g. { "classify": { "costPreference": "low" } }
  model_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  system_instructions text,
  instructions_version integer NOT NULL DEFAULT 1,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agents_tenant_id ON public.agents (tenant_id);
CREATE INDEX IF NOT EXISTS idx_agents_agent_type ON public.agents (agent_type);

ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;

-- Read-only for tenant members for now — no self-serve agent configuration
-- UI ships in P0 (that's P1+). Writes go through the service-role registry
-- code in lib/agents/registry.ts.
DROP POLICY IF EXISTS agents_select_tenant ON public.agents;
CREATE POLICY agents_select_tenant ON public.agents
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));
