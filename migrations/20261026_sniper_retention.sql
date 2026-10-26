-- Nightly sniper cleanup (Kevin Oct 26, 2026). Run by hand in the Supabase SQL editor.
-- Replaces the 7-day sniper_decisions_prune job from #270 (that job was never scheduled).
--
-- sniper_ledger: deletes ONLY rows that are released, never filled, with no fill_ids, no order_id,
--   no realized_pnl, and created more than 2 days ago. Open, filled, settled, accepted and any
--   P&L rows are never touched.
-- sniper_decisions: deletes rows older than 3 days, except 'summary' and 'book_arb' rows and any
--   row for an RFQ that was filled or has an order_id in sniper_ledger.
-- Both delete in 50k-row chunks. Runs at 08:15 UTC = 4:15 AM ET (EDT) / 3:15 AM ET (EST).

create or replace function public.sniper_retention_prune(
  p_ledger_keep interval default interval '2 days',
  p_decisions_keep interval default interval '3 days',
  p_chunk int default 50000)
returns table(ledger_deleted bigint, decisions_deleted bigint)
language plpgsql security definer set search_path = public as $$
declare n bigint; l_total bigint := 0; d_total bigint := 0;
begin
  loop
    delete from sniper_ledger where rfq_id in (
      select rfq_id from sniper_ledger
      where status = 'released'
        and coalesce(filled_contracts, 0) = 0
        and (fill_ids is null or cardinality(fill_ids) = 0)
        and order_id is null
        and realized_pnl is null
        and created_at < now() - p_ledger_keep
      limit p_chunk);
    get diagnostics n = row_count; l_total := l_total + n;
    exit when n < p_chunk;
  end loop;

  loop
    delete from sniper_decisions where id in (
      select d.id from sniper_decisions d
      where d.created_at < now() - p_decisions_keep
        and d.action not in ('summary', 'book_arb')
        and not exists (
          select 1 from sniper_ledger l
          where l.rfq_id = d.rfq_id
            and (coalesce(l.filled_contracts, 0) > 0 or l.order_id is not null))
      order by d.created_at
      limit p_chunk);
    get diagnostics n = row_count; d_total := d_total + n;
    exit when n < p_chunk;
  end loop;

  return query select l_total, d_total;
end $$;
revoke all on function public.sniper_retention_prune(interval, interval, int) from public, anon, authenticated;

select cron.unschedule('sniper_decisions_prune') where exists (select 1 from cron.job where jobname = 'sniper_decisions_prune');
select cron.unschedule('sniper_retention_prune') where exists (select 1 from cron.job where jobname = 'sniper_retention_prune');
select cron.schedule('sniper_retention_prune', '15 8 * * *', $$select public.sniper_retention_prune()$$);

-- First run now (optional; may take a few minutes on ~1.8M rows):
-- select * from public.sniper_retention_prune();
