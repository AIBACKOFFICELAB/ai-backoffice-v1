-- PREVIEW-ONLY VARIANT of canonical migration 008_missed_call_recovery_full_notifications.sql
-- Canonical source commit: ba8824807c23cc90c8668184f2cafa8ef89fe772 (db/migrations/008_missed_call_recovery_full_notifications.sql)
-- Deliberate variation: the historical Production-specific tenant configuration UPDATE is omitted.
-- It targeted exactly one tenant row that does not exist in this Preview project, so it has no
-- schema effect. No replacement seed values are introduced. All ALTER TABLE statements are unchanged.
-- This file is NOT the canonical migration and must be recorded under a distinct ledger name.

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
