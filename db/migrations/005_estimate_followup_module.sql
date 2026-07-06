-- Estimate Follow-up module: Configuration + History + Settings layers
-- Day 1 / Day 3 / Day 7 sequenced follow-up with reply detection

CREATE TABLE IF NOT EXISTS public.estimate_followup_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  day1_template text NOT NULL DEFAULT
    'Hi {{customer_name}}, just checking in on the estimate we sent for your {{service_type}} job. Any questions? Reply here anytime.',
  day3_template text NOT NULL DEFAULT
    'Hi {{customer_name}}, following up on your {{service_type}} estimate — still happy to help whenever you''re ready to move forward.',
  day7_template text NOT NULL DEFAULT
    'Hi {{customer_name}}, wanted to do one last check-in on your {{service_type}} estimate before we close it out. Let us know if you''d like to proceed!',
  stop_on_reply boolean NOT NULL DEFAULT true,
  stop_on_status_change boolean NOT NULL DEFAULT true,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.estimate_followup_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ef_settings_tenant ON public.estimate_followup_settings;
CREATE POLICY ef_settings_tenant ON public.estimate_followup_settings
  FOR ALL
  USING (public.is_tenant_member(tenant_id))
  WITH CHECK (public.is_tenant_member(tenant_id));

-- One sequence row tracks a single lead's follow-up progress through Day 1/3/7
CREATE TABLE IF NOT EXISTS public.estimate_followup_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  lead_id text NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  estimate_sent_at timestamp with time zone NOT NULL,
  day1_due_at timestamp with time zone NOT NULL,
  day3_due_at timestamp with time zone NOT NULL,
  day7_due_at timestamp with time zone NOT NULL,
  day1_sent_at timestamp with time zone,
  day3_sent_at timestamp with time zone,
  day7_sent_at timestamp with time zone,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replied', 'completed', 'stopped')),
  stopped_reason text,
  last_reply_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE (tenant_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_ef_sequences_tenant_id ON public.estimate_followup_sequences (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ef_sequences_status ON public.estimate_followup_sequences (status);
CREATE INDEX IF NOT EXISTS idx_ef_sequences_due_dates ON public.estimate_followup_sequences (day1_due_at, day3_due_at, day7_due_at);

ALTER TABLE public.estimate_followup_sequences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ef_sequences_tenant ON public.estimate_followup_sequences;
CREATE POLICY ef_sequences_tenant ON public.estimate_followup_sequences
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));

-- History: every individual send/reply event for a sequence
CREATE TABLE IF NOT EXISTS public.estimate_followup_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES public.estimate_followup_sequences(id) ON DELETE CASCADE,
  lead_id text NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('day1_sent', 'day3_sent', 'day7_sent', 'reply_detected', 'stopped', 'completed', 'send_failed')),
  channel text NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms', 'email')),
  message_body text,
  provider_sid text,
  failure_reason text,
  occurred_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ef_history_tenant_id ON public.estimate_followup_history (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ef_history_sequence_id ON public.estimate_followup_history (sequence_id);
CREATE INDEX IF NOT EXISTS idx_ef_history_occurred_at ON public.estimate_followup_history (occurred_at);

ALTER TABLE public.estimate_followup_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ef_history_tenant ON public.estimate_followup_history;
CREATE POLICY ef_history_tenant ON public.estimate_followup_history
  FOR SELECT
  USING (public.is_tenant_member(tenant_id));
