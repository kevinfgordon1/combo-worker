-- Rollback for 20261023c_sniper_reserve_fast.sql: restores the 20261022 cap check (re-run that
-- file's sniper_cap_reason), then removes the counter. Indexes are harmless and may stay.
drop trigger if exists sniper_hour_bucket on public.sniper_ledger;
drop function if exists public.sniper_hour_bucket_trg();
-- run migrations/20261022_sniper_daily_filled_cap.sql (sniper_cap_reason) BEFORE the next two lines
drop function if exists public.sniper_hour_count(boolean, timestamptz);
drop function if exists public.sniper_hour_buckets_prune();
drop table if exists public.sniper_hour_buckets;
