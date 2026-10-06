-- AIBO-RD-M001 Revenue Desk: receptionist + structured intake + booking foundation.
-- Tenant config, call evidence, booking state machine. All writes go through
-- the service-role server adapter; tenant members may only READ their own rows.
-- No credentials are stored in any of these tables.

-- Composite targets so child rows can never point at another tenant's lead/call.
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_id_tenant ON public.leads (id, tenant_id);

-- 1. Tenant configuration (Founder-assisted; disabled by default) ------------
CREATE TABLE IF NOT EXISTS public.revenue_desk_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  business_phone text,
  vapi_phone_number_id text UNIQUE,
  vapi_assistant_id text,
  greeting text,
  timezone text NOT NULL DEFAULT 'America/New_York',
  operating_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  service_categories jsonb NOT NULL DEFAULT '[]'::jsonb,
  service_area jsonb NOT NULL DEFAULT '{}'::jsonb,
  urgency_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  booking_enabled boolean NOT NULL DEFAULT false,
  default_appointment_duration_minutes integer NOT NULL DEFAULT 60 CHECK (default_appointment_duration_minutes BETWEEN 15 AND 480),
  service_durations jsonb NOT NULL DEFAULT '{}'::jsonb,
  buffer_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
  calendar_provider text NOT NULL DEFAULT 'google' CHECK (calendar_provider IN ('google')),
  calendar_id text,
  escalation_phone text,
  faqs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Calls (one row per provider call, replay-safe) ---------------------------
CREATE TABLE IF NOT EXISTS public.revenue_desk_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'vapi' CHECK (provider IN ('vapi')),
  provider_call_id text NOT NULL,
  provider_phone_number_id text,
  caller_phone text,
  called_phone text,
  lead_id text,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'intake_captured', 'booked', 'escalated', 'completed', 'failed')),
  priority text CHECK (priority IN ('routine', 'priority', 'urgent', 'human_escalation_required')),
  urgency_signals text[] NOT NULL DEFAULT '{}',
  service_category text,
  intake jsonb,                       -- structured intake only; never a transcript
  escalation_reason text,
  escalation_result text CHECK (escalation_result IN ('requested', 'transferred', 'transfer_failed', 'not_required')),
  booking_outcome text CHECK (booking_outcome IN ('confirmed', 'conflict', 'failed', 'not_attempted', 'unavailable')),
  availability_checked_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  provider_cost_usd numeric(10, 4),
  ended_reason text,
  failure_category text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_call_id),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES public.leads (id, tenant_id) ON DELETE SET NULL (lead_id)
);
CREATE INDEX IF NOT EXISTS idx_rd_calls_tenant_started ON public.revenue_desk_calls (tenant_id, created_at DESC);

-- 3. Bookings: durable state machine -----------------------------------------
CREATE TABLE IF NOT EXISTS public.revenue_desk_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  call_id uuid NOT NULL,
  lead_id text,
  idempotency_key text NOT NULL,
  provider text NOT NULL DEFAULT 'google' CHECK (provider IN ('google')),
  calendar_id text NOT NULL,
  requested_start timestamptz NOT NULL,
  requested_end timestamptz NOT NULL CHECK (requested_end > requested_start),
  timezone text NOT NULL,
  provider_event_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'conflict', 'failed', 'cancelled')),
  failure_category text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (status <> 'confirmed' OR provider_event_id IS NOT NULL),
  FOREIGN KEY (call_id, tenant_id) REFERENCES public.revenue_desk_calls (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (lead_id, tenant_id) REFERENCES public.leads (id, tenant_id) ON DELETE SET NULL (lead_id)
);
-- One live booking per call, and an AIBO slot guard per tenant calendar.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_bookings_live_per_call
  ON public.revenue_desk_bookings (tenant_id, call_id) WHERE status IN ('pending', 'confirmed');
CREATE UNIQUE INDEX IF NOT EXISTS uq_rd_bookings_live_slot
  ON public.revenue_desk_bookings (tenant_id, calendar_id, requested_start) WHERE status IN ('pending', 'confirmed');

-- 4. RLS: members read their own tenant's rows; no member writes at all -------
ALTER TABLE public.revenue_desk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revenue_desk_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revenue_desk_bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rd_settings_select_tenant ON public.revenue_desk_settings;
CREATE POLICY rd_settings_select_tenant ON public.revenue_desk_settings FOR SELECT USING (public.is_tenant_member(tenant_id));
DROP POLICY IF EXISTS rd_calls_select_tenant ON public.revenue_desk_calls;
CREATE POLICY rd_calls_select_tenant ON public.revenue_desk_calls FOR SELECT USING (public.is_tenant_member(tenant_id));
DROP POLICY IF EXISTS rd_bookings_select_tenant ON public.revenue_desk_bookings;
CREATE POLICY rd_bookings_select_tenant ON public.revenue_desk_bookings FOR SELECT USING (public.is_tenant_member(tenant_id));
-- Deliberately no INSERT/UPDATE/DELETE policies: escalation_phone, calendar_id
-- and enabled flags are Founder-configured, never tenant-member editable.
