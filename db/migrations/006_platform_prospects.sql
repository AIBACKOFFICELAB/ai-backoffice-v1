-- Platform-level prospect intake — NOT tenant-scoped. These are businesses
-- considering becoming an AI BackOffice client (Discovery stage, per
-- docs/constitution/04_SYSTEM_LIFECYCLE.md), submitted via the landing
-- page's "Book a Free Audit" flow, before any tenant/account exists for them.

CREATE TABLE IF NOT EXISTS public.platform_prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name text NOT NULL,
  contact_name text,
  email text,
  phone text,
  business_type text,
  message text,
  source text NOT NULL DEFAULT 'landing_page_audit_form',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'scheduled', 'converted', 'disqualified')),
  converted_tenant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_prospects_status ON public.platform_prospects (status);
CREATE INDEX IF NOT EXISTS idx_platform_prospects_created_at ON public.platform_prospects (created_at);

ALTER TABLE public.platform_prospects ENABLE ROW LEVEL SECURITY;
-- No policies: this table is internal-only, accessed exclusively via the
-- service-role server client (AI BackOffice's own team reviewing prospects),
-- never directly by a tenant user. Deny-by-default is intentional.
