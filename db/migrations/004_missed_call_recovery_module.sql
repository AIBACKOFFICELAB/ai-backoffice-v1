-- Missed Call Recovery module: Configuration + History + Settings layers
-- per docs/constitution/03_MODULE_ARCHITECTURE.md

CREATE TABLE IF NOT EXISTS public.missed_call_recovery_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  business_phone text,
  sms_template text NOT NULL DEFAULT
    'Hi, sorry we missed your call at {{business_name}}! Reply with your name and what you need help with and we''ll get right back to you.',
  owner_alert_phone text,
  emergency_keywords text[] NOT NULL DEFAULT ARRAY['emergency', 'flooding', 'burst', 'no water', 'gas leak'],
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.missed_call_recovery_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mcr_settings_tenant ON public.missed_call_recovery_settings;
CREATE POLICY mcr_settings_tenant ON public.missed_call_recovery_settings
  FOR ALL
  USING (public.is_tenant_member(tenant_id))
  WITH CHECK (public.is_tenant_member(tenant_id));

CREATE TABLE IF NOT EXISTS public.missed_call_recovery_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  caller_phone text NOT NULL,
  call_sid text,
  lead_id text REFERENCES public.leads(id) ON DELETE SET NULL,
  trigger_source text NOT NULL DEFAULT 'twilio_missed_call',
  triggered_at timestamp with time zone DEFAULT now() NOT NULL,
  sms_sent boolean NOT NULL DEFAULT false,
  sms_sid text,
  owner_alerted boolean NOT NULL DEFAULT false,
  is_emergency boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'recovered', 'failed', 'skipped')),
  failure_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcr_history_tenant_id ON public.missed_call_recovery_history (tenant_id);
CREATE INDEX IF NOT EXISTS idx_mcr_history_created_at ON public.missed_call_recovery_history (created_at);

ALTER TABLE public.missed_call_recovery_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mcr_history_tenant ON public.missed_call_recovery_history;
CREATE POLICY mcr_history_tenant ON public.missed_call_recovery_history
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));
