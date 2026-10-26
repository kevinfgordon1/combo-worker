-- Rollback for 20261026_sniper_retention.sql: stop the nightly job and drop the function.
-- Deleted rows are not restored.
select cron.unschedule('sniper_retention_prune') where exists (select 1 from cron.job where jobname = 'sniper_retention_prune');
drop function if exists public.sniper_retention_prune(interval, interval, int);
