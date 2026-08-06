-- Close the anon-executable SECURITY DEFINER vector (linter: anon_security_definer_function_
-- executable, WARN). The public anon key could POST /rest/v1/rpc/<fn> to run SECURITY DEFINER
-- functions that BYPASS RLS — reading aggregate/graph data (brain_stats_aggregate,
-- constellation_*, brain_duplicates_find) and mutating the work queues (claim_*). Verified:
-- anon could call them (HTTP 200) pre-fix; HTTP 401 after.
--
-- Revoke EXECUTE from PUBLIC + anon + authenticated (the public-facing roles); GUARANTEE
-- service_role keeps EXECUTE (OB's Edge Functions call every RPC as service_role via the
-- sb_secret key — ACL-verified service_role holds its own explicit grant). postgres/owner
-- unaffected. Applied live via the Management API 2026-08-06 (Adam's direct in-session go)
-- and verified: anon /rpc/* -> 401; rest-api /entities/hygiene + /stats (service_role) -> 200.
-- Reversible: GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
GRANT  EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
