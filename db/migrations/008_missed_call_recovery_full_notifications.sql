-- Extend Missed Call Recovery settings with owner notification + intake fields
ALTER TABLE public.missed_call_recovery_settings
  ADD COLUMN IF NOT EXISTS owner_notification_email text,
  ADD COLUMN IF NOT EXISTS intake_form_url text,
  ADD COLUMN IF NOT EXISTS emergency_phone text,
  ADD COLUMN IF NOT EXISTS business_tagline text;

-- Extend history with per-channel status so recovery/owner-SMS/owner-email
-- can each be shown and audited independently, per docs/constitution
-- 03_MODULE_ARCHITECTURE.md's History layer requirements.
ALTER TABLE public.missed_call_recovery_history
  ADD COLUMN IF NOT EXISTS recovery_sms_status text NOT NULL DEFAULT 'pending' CHECK (recovery_sms_status IN ('pending', 'sent', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS recovery_sms_failure_reason text,
  ADD COLUMN IF NOT EXISTS owner_sms_status text NOT NULL DEFAULT 'pending' CHECK (owner_sms_status IN ('pending', 'sent', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS owner_sms_sid text,
  ADD COLUMN IF NOT EXISTS owner_sms_failure_reason text,
  ADD COLUMN IF NOT EXISTS owner_email_status text NOT NULL DEFAULT 'pending' CHECK (owner_email_status IN ('pending', 'sent', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS owner_email_failure_reason text;

-- Seed real production values for the 5 Star Plumbing tenant
UPDATE public.missed_call_recovery_settings
SET
  owner_alert_phone = '+17866066944',
  owner_notification_email = '5starplumbing05@gmail.com',
  intake_form_url = 'https://bit.ly/4fPtzlm',
  emergency_phone = '+17866066944',
  business_tagline = 'The Right Way',
  sms_template = 'Hi! This is {{business_name}}. Sorry we missed your call. We want to help you as soon as possible. Please fill out our quick service request form and we will contact you shortly: {{intake_form_url}}

For emergencies, call back or send a text with your emergency matter description: {{emergency_phone}}

- {{business_name}} ''{{business_tagline}}''',
  updated_at = now()
WHERE tenant_id = '32e5bfa9-6d3b-4801-aca5-1a42d818ae67';
