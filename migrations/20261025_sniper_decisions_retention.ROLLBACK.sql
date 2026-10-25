select cron.unschedule('sniper_decisions_prune') where exists (select 1 from cron.job where jobname = 'sniper_decisions_prune');
drop function if exists public.sniper_decisions_prune(interval, int);
