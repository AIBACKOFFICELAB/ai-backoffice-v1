-- AIBO-RD-M006B-SEC-01 — PROPOSED forward-only grant hardening (DRAFT — NOT APPLIED)
-- Target: Preview project wasugleumzcigegeuyua ONLY. Intended ordering: after the
-- applied 008 Preview variant, BEFORE migrations 009–012.
--
-- Intent: remove unnecessary client privileges, keep every privilege the existing
-- RLS contracts depend on, and stop new tables inheriting write grants for
-- client roles. Does NOT change is_tenant_member() grants, any RLS policy,
-- platform_prospects policies, or any canonical migration source.
--
-- Verified facts this relies on (disposable-DB + read-only hosted checks):
--   * Server app client (lib/supabase/server.ts) uses the service-role key; the
--     request role becomes authenticated when a user session is present.
--   * Browser client (lib/supabase/client.ts) is used only by auth pages; no
--     client-side table access, so anon has no legitimate table privileges.
--   * Tenant policies are all membership-based; anon is never a member.

-- 1. anon: no table privileges on existing application tables.
REVOKE ALL ON TABLE
  public.tenants,
  public.tenant_memberships,
  public.leads,
  public.missed_call_recovery_settings,
  public.missed_call_recovery_history,
  public.estimate_followup_sequences,
  public.estimate_followup_settings,
  public.estimate_followup_history,
  public.platform_prospects
FROM anon;

-- 2. authenticated: remove TRUNCATE / REFERENCES / TRIGGER / MAINTAIN (not governed by RLS).
--    DML is kept where existing RLS policies govern it (leads CRUD, settings, etc.).
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLE
  public.tenants,
  public.tenant_memberships,
  public.leads,
  public.missed_call_recovery_settings,
  public.missed_call_recovery_history,
  public.estimate_followup_sequences,
  public.estimate_followup_settings,
  public.estimate_followup_history,
  public.platform_prospects
FROM authenticated;

-- 3. Future tables created by the migration-executing role (postgres, schema public):
--    remove anon entirely and authenticated write privileges from the schema default.
--    authenticated keeps SELECT, matching tenant-member read policies in 009–027.
--    service_role default is unchanged.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES FROM authenticated;
