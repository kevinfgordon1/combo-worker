-- Rollback of 20261023f: hedges stop affecting caps (table sniper_hedges is kept).
create or replace function public.sniper_open_rows(p_exclude text, p_live boolean)
returns setof public.sniper_ledger language sql stable set search_path = public as $$
  select * from sniper_ledger
   where status = 'open' and dry_run = not p_live
     and (release_at > now() or phase in ('accepted','filled'))
     and (p_exclude is null or rfq_id <> p_exclude)
$$;

create or replace function public.sniper_day_exposure(p_day_start timestamptz, p_live boolean)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'filled', coalesce((select sum(filled_cost) from sniper_ledger
                         where dry_run = not p_live and created_at >= p_day_start and filled_contracts > 0), 0),
    'fills', (select count(*) from sniper_ledger
                where dry_run = not p_live and created_at >= p_day_start and filled_contracts > 0),
    'pending', coalesce((select sum(risk) from sniper_open_rows(null, p_live) where phase not in ('filled','settled')), 0))
$$;

lude text, p_count_new boolean, p_long boolean default true)
returns text language plpgsql stable set search_path = public as $$
declare v numeric; d timestamptz := (p_caps->>'day_start')::timestamptz;
  lv boolean := coalesce((p_caps->>'live')::boolean, false);
  h numeric := coalesce((p_caps->>'short_settle_hours')::numeric, 32);
  v_total numeric; v_long numeric;drop function if exists public.sniper_hedge_pnl(text, text);
drop function if exists public.sniper_hedged_risk(numeric, text, numeric, numeric, numeric, numeric, numeric);
drop function if exists public.sniper_american_decimal(numeric);
