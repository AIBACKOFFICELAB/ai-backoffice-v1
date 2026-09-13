-- Canonical Lead Intake v2. Development migration; NOT applied to production.
-- Existing records remain unchanged; legacy writers may omit these fields.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS source_ref text,
  ADD COLUMN IF NOT EXISTS intake_schema_version integer,
  ADD COLUMN IF NOT EXISTS received_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_tenant_source_ref
  ON public.leads (tenant_id, source, source_ref)
  WHERE source_ref IS NOT NULL;

-- No tenant schema change: tenants.slug is already UNIQUE NOT NULL.
-- No grants or RLS policies are changed.
