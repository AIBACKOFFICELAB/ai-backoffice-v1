-- Disposable-environment scaffold ONLY — never applied to production.
--
-- Replicates the minimal slice of real Supabase/Postgres-on-Supabase
-- platform surface that db/migrations/001-019 actually depend on, so those
-- migration files can be applied VERBATIM (byte-for-byte, unmodified) to a
-- local Postgres 16 instance for P0.9 Slice D's real-Postgres proof:
--   - extensions providing gen_random_uuid()
--   - an `auth` schema with a `users` table (FK target for
--     tenant_memberships.user_id and approvals.approver_user_id) and a
--     `uid()` function matching Supabase's own published implementation
--     (reads the `request.jwt.claims` session GUC PostgREST sets per
--     request from the caller's JWT — see
--     https://supabase.com/docs/guides/database/postgres/row-level-security)
--   - the anon / authenticated / service_role roles Supabase provisions on
--     every project, with the same BYPASSRLS posture on service_role and
--     the same broad default table grants (RLS is the actual gate, exactly
--     as it is in the real project)
--
-- Local Postgres is 16.13; production (yohfpsaemgibarlgodmh) is on the
-- Postgres 17 engine. Nothing any migration 001-020 uses is
-- version-dependent between 16 and 17 (plain DDL, jsonb, partial unique
-- indexes, composite FKs with column-scoped ON DELETE SET NULL — all
-- present since PG15) — see the Slice D completion report for the explicit
-- version-parity note.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);

-- Matches Supabase's own auth.uid() definition exactly: reads the 'sub'
-- claim out of the request.jwt.claims session GUC that PostgREST sets from
-- the caller's verified JWT before running any per-request SQL. Tests
-- simulate "as a specific authenticated user" with:
--   SET LOCAL request.jwt.claims = '{"sub":"<uuid>"}';
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  -- The 'postgres' connection role must be able to SET ROLE to each of
  -- these to simulate a request arriving as that role (no login needed for
  -- them individually — tests connect as 'postgres' and SET ROLE).
  GRANT anon, authenticated, service_role TO postgres;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

-- Supabase's real default: broad table-level grants to anon/authenticated,
-- with RLS as the actual access-control layer (not table-level GRANTs).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
