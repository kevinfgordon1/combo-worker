-- Oct 25 2026 outage follow-up: per-role DB timeouts (paste into the Supabase SQL editor).
-- Before (checked 2026-10-25): authenticator statement_timeout=8s, lock_timeout=8s,
--   session_preload_libraries=safeupdate; anon 3s; authenticated 8s; service_role NONE (inherits 8s).
-- PostgREST applies the impersonated role's settings per request, so:
--   * every app (combo-worker, sniper, testers, poly, aibetbuilder server routes) runs as service_role;
--   * dashboard users run as authenticated (combo_submissions reads reach 7-8s today, so it stays 8s);
--   * authenticator is the fallback for any role without its own value.
-- Heavy jobs checked: pg_cron (auto-archive-parlays, rfq_hourly_refresh, noboost_paper_retention) runs
-- as postgres and is NOT affected; slowest service_role statement since stats reset ~1.8s; dayRecap
-- reads ~2-4s avg / 8s max, so service_role keeps 8s (no behaviour change for slow reads).
-- The real new protection is idle_in_transaction_session_timeout: no session can sit on a pool
-- connection inside an open transaction (what wedged the pool) for more than 5-10s.
begin;
alter role authenticator set statement_timeout = '3s';
alter role authenticator set idle_in_transaction_session_timeout = '5s';
alter role service_role  set statement_timeout = '8s';
alter role service_role  set idle_in_transaction_session_timeout = '10s';
alter role authenticated set idle_in_transaction_session_timeout = '5s';
alter role anon          set idle_in_transaction_session_timeout = '5s';
commit;
notify pgrst, 'reload config';
-- Check:
-- select rolname, rolconfig from pg_roles where rolname in ('authenticator','service_role','authenticated','anon');

-- ROLLBACK (restores the exact settings above):
-- begin;
-- alter role authenticator set statement_timeout = '8s';
-- alter role authenticator reset idle_in_transaction_session_timeout;
-- alter role service_role  reset statement_timeout;
-- alter role service_role  reset idle_in_transaction_session_timeout;
-- alter role authenticated reset idle_in_transaction_session_timeout;
-- alter role anon          reset idle_in_transaction_session_timeout;
-- commit;
-- notify pgrst, 'reload config';
