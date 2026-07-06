-- Migration: Multi-tenant architecture + Row Level Security
-- Founder Deployment Sprint — Priority 1
-- Introduces tenants, tenant_memberships, tenant-scoped leads, and RLS
-- policies per docs/constitution/06_DATABASE_PRINCIPLES.md (Article VII of
-- 02_PRODUCT_CONSTITUTION.md: tenant isolation is non-negotiable).

-- 1. Core tenant table -------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL,
  business_type text,
  timezone text NOT NULL DEFAULT 'America/New_York',
  phone text,
  email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'churned')),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- 2. Tenant membership — links Supabase auth users to a tenant ---------

CREATE TABLE IF NOT EXISTS public.tenant_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'staff')),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user_id ON public.tenant_memberships (user_id);

-- 3. Add tenant_id to leads ---------------------------------------------

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_id ON public.leads (tenant_id);

-- 4. Helper: does the current auth user belong to a given tenant? ------

CREATE OR REPLACE FUNCTION public.is_tenant_member(check_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_memberships
    WHERE tenant_id = check_tenant_id
      AND user_id = auth.uid()
  );
$$;

-- 5. Enable RLS ----------------------------------------------------------

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

-- 6. Policies: tenants — a user can see/update only tenants they belong to

DROP POLICY IF EXISTS tenants_select_own ON public.tenants;
CREATE POLICY tenants_select_own ON public.tenants
  FOR SELECT
  USING (public.is_tenant_member(id));

DROP POLICY IF EXISTS tenants_update_own ON public.tenants;
CREATE POLICY tenants_update_own ON public.tenants
  FOR UPDATE
  USING (public.is_tenant_member(id))
  WITH CHECK (public.is_tenant_member(id));

-- 7. Policies: tenant_memberships — a user can see only their own membership rows

DROP POLICY IF EXISTS memberships_select_own ON public.tenant_memberships;
CREATE POLICY memberships_select_own ON public.tenant_memberships
  FOR SELECT
  USING (user_id = auth.uid());

-- 8. Policies: leads — full CRUD scoped to tenant membership

DROP POLICY IF EXISTS leads_select_tenant ON public.leads;
CREATE POLICY leads_select_tenant ON public.leads
  FOR SELECT
  USING (tenant_id IS NOT NULL AND public.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS leads_insert_tenant ON public.leads;
CREATE POLICY leads_insert_tenant ON public.leads
  FOR INSERT
  WITH CHECK (tenant_id IS NOT NULL AND public.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS leads_update_tenant ON public.leads;
CREATE POLICY leads_update_tenant ON public.leads
  FOR UPDATE
  USING (tenant_id IS NOT NULL AND public.is_tenant_member(tenant_id))
  WITH CHECK (tenant_id IS NOT NULL AND public.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS leads_delete_tenant ON public.leads;
CREATE POLICY leads_delete_tenant ON public.leads
  FOR DELETE
  USING (tenant_id IS NOT NULL AND public.is_tenant_member(tenant_id));

-- NOTE: service_role (used by server-side automation/API routes with the
-- service key) bypasses RLS by default in Supabase. Per
-- docs/constitution/06_DATABASE_PRINCIPLES.md, every such usage must
-- explicitly filter by tenant_id in application code — RLS is the backstop,
-- not a substitute for correct application-level scoping when service_role
-- is used.
