-- Rollback: re-run migrations/20261023c_sniper_reserve_fast.sql's sniper_cap_reason section and
-- 20261021b's sniper_reserve / sniper_confirm_check, then:
drop function if exists public.sniper_cap_reason(numeric, text[], text[], jsonb, text, boolean, boolean);
drop function if exists public.sniper_open_split(boolean, numeric);
-- settle_at column can stay (unused). Set SNIPER_TOTAL_EXPOSURE_CAP back to 5000 first.
