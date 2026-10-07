-- AIBO-RD-M001 Revenue Desk: database-authoritative booking leases.
--
-- Additive on top of 026 (which is not edited). A pending booking row is a
-- lease: while it is fresh, another request for the same appointment must not
-- write a calendar event. Lease age was previously judged by the APPLICATION
-- clock against a timestamp that the database (insert default) or the
-- application (updates) had written, so clock skew between app instances and
-- Postgres could expire a live lease early (duplicate write risk) or hold a
-- dead one too long. After this migration:
--   * every booking timestamp is written by Postgres (insert default + trigger);
--   * lease expiry is decided and taken in ONE conditional UPDATE using the
--     database clock. Concurrent claimers serialize on the row lock and the
--     loser re-evaluates the predicate against the winner's fresh timestamp,
--     so at most one request acquires an expired lease.
--
-- Lock / deployment note: CREATE FUNCTION / CREATE TRIGGER take a brief
-- lock on revenue_desk_bookings only. PostgREST must reload its schema cache
-- (NOTIFY pgrst, 'reload schema') before the server adapter can call the RPC.
-- Revert: DROP FUNCTION public.revenue_desk_claim_booking_lease(uuid, uuid, integer);
--         DROP TRIGGER trg_rd_bookings_updated_at ON public.revenue_desk_bookings;
--         DROP FUNCTION public.revenue_desk_bookings_touch_updated_at();

-- 1. Postgres owns updated_at on every booking update ------------------------
CREATE OR REPLACE FUNCTION public.revenue_desk_bookings_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_rd_bookings_updated_at ON public.revenue_desk_bookings;
CREATE TRIGGER trg_rd_bookings_updated_at
  BEFORE UPDATE ON public.revenue_desk_bookings
  FOR EACH ROW EXECUTE FUNCTION public.revenue_desk_bookings_touch_updated_at();

-- 2. Atomic, DB-clock lease acquisition ---------------------------------------
-- Returns the claimed row only when it is still pending AND its lease (last
-- DB-written updated_at + p_lease_seconds) has expired by the DATABASE clock;
-- otherwise returns no rows. Tenant-scoped; bounded lease length.
CREATE OR REPLACE FUNCTION public.revenue_desk_claim_booking_lease(p_tenant_id uuid, p_booking_id uuid, p_lease_seconds integer)
RETURNS SETOF public.revenue_desk_bookings
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE public.revenue_desk_bookings
     SET updated_at = now()
   WHERE tenant_id = p_tenant_id
     AND id = p_booking_id
     AND status = 'pending'
     AND p_lease_seconds BETWEEN 1 AND 3600
     AND updated_at <= now() - make_interval(secs => p_lease_seconds)
  RETURNING *;
$$;

COMMENT ON FUNCTION public.revenue_desk_claim_booking_lease(uuid, uuid, integer) IS
  'Revenue Desk server adapter only: take over an expired pending booking lease using the database clock.';

-- Server adapter (service_role) only. Supabase projects grant EXECUTE on new
-- public functions DIRECTLY to anon/authenticated via default ACLs (see 022),
-- so revoking from PUBLIC alone is insufficient: revoke from each explicitly.
-- Members have no UPDATE policy on bookings anyway (026); this keeps the RPC
-- surface closed rather than relying on RLS.
REVOKE EXECUTE ON FUNCTION public.revenue_desk_claim_booking_lease(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revenue_desk_claim_booking_lease(uuid, uuid, integer) TO service_role, postgres;
REVOKE EXECUTE ON FUNCTION public.revenue_desk_bookings_touch_updated_at() FROM PUBLIC, anon, authenticated;
