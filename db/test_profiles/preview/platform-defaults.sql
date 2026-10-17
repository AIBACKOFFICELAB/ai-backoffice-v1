-- Disposable Preview profile only. The historical scaffold supplies table
-- defaults; Supabase also supplies these direct function grants. SEC-01 later
-- narrows table defaults but leaves function/sequence defaults unchanged.
-- Sequences are representative; H001 introduces no sequence dependency.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
