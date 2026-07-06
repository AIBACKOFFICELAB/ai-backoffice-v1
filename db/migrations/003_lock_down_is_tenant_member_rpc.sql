-- Security hardening: is_tenant_member is an internal RLS helper, not a
-- public RPC. Revoke anon/authenticated EXECUTE so it can't be called
-- directly via /rest/v1/rpc/is_tenant_member (flagged by Supabase advisors).

REVOKE EXECUTE ON FUNCTION public.is_tenant_member(uuid) FROM anon, authenticated, public;
