-- Nightly retention for sniper_decisions (~730k rows/day, ~2.7 GB on Oct 25 2026).
-- Deletes rows older than 7 days in 50k-row chunks (short locks). Run by hand in the SQL editor.
-- pg_cron is already enabled on this project. Schedule is UTC: 08:15 UTC = 4:15 AM ET (EDT).
create or replace function public.sniper_decisions_prune(p_keep interval default interval '7 days', p_chunk int default 50000)
returns bigint language plpgsql security definer set search_path = public as $$
declare n bigint; total bigint := 0;
begin
  loop
    delete from sniper_decisions where id in (
      select id from sniper_decisions where created_at < now() - p_keep order by created_at limit p_chunk);
    get diagnostics n = row_count; total := total + n;
    exit when n < p_chunk;
  end loop;
  return total;
end $$;
revoke all on function public.sniper_decisions_prune(interval, int) from public, anon, authenticated;

select cron.unschedule('sniper_decisions_prune') where exists (select 1 from cron.job where jobname = 'sniper_decisions_prune');
select cron.schedule('sniper_decisions_prune', '15 8 * * *', $$select public.sniper_decisions_prune()$$);
