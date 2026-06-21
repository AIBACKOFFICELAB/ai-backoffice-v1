-- Migration: Create leads table for AI BackOffice pilot

CREATE TABLE IF NOT EXISTS public.leads (
  id text PRIMARY KEY,
  date timestamp with time zone NOT NULL,
  customer_name text NOT NULL,
  phone text NOT NULL,
  email text,
  service_address text NOT NULL,
  property_type text NOT NULL,
  service_type text NOT NULL,
  emergency text NOT NULL,
  urgency text NOT NULL,
  job_description text NOT NULL,
  photos_uploaded text NOT NULL,
  preferred_appointment_time text,
  customer_role text NOT NULL,
  lead_source text NOT NULL,
  customer_notes text,
  status text NOT NULL,
  estimate_amount numeric NOT NULL DEFAULT 0,
  follow_up_date text,
  review_request_status text NOT NULL,
  internal_notes text,
  source text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  sms_sent_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON public.leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_follow_up_date ON public.leads (follow_up_date);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON public.leads (created_at);
