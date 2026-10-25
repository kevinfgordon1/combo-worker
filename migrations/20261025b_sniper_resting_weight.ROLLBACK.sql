-- Restores the pre-20261025b functions (copied from prod Oct 25 2026, 11:05 AM ET).
CREATE OR REPLACE FUNCTION public.sniper_cap_reason(p_risk numeric, p_games text[], p_legs text[], p_caps jsonb, p_exclude text, p_count_new boolean, p_long boolean DEFAULT true)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare v numeric; d timestamptz := (p_caps->>'day_start')::timestamptz;
  lv boolean := coalesce((p_caps->>'live')::boolean, false);
  h numeric := coalesce((p_caps->>'short_settle_hours')::numeric, 32);
  v_total numeric; v_long numeric; v_game numeric; v_leg numeric; v_ph bigint;
begin
  -- Kalshi realized P&L today PLUS the P&L of active book hedges on those same settled fills.
  select coalesce(sum(realized_pnl), 0) + coalesce(sum(sniper_hedge_pnl(rfq_id, market_result)), 0) into v from sniper_ledger where settled_at >= d and dry_run = false;
  if -v >= (p_caps->>'daily_loss')::numeric then return 'daily_loss_halt'; end if;
  with o as materialized (select risk, games, legs, settle_at, created_at from sniper_open_rows(p_exclude, lv))
  select coalesce((select sum(risk) from o), 0),
         coalesce((select sum(risk) from o where sniper_is_long(settle_at, created_at, h)), 0),
         coalesce((select max(s) from (select sum(o.risk) s from (select distinct x from unnest(coalesce(p_games, '{}')) u(x)) g join o on g.x = any(o.games) group by g.x) a), 0),
         coalesce((select max(s) from (select sum(o.risk) s from (select distinct x from unnest(coalesce(p_legs, '{}')) u(x)) l join o on l.x = any(o.legs) group by l.x) b), 0)
    into v_total, v_long, v_game, v_leg;
  if v_total + p_risk > (p_caps->>'total')::numeric then return 'total_cap'; end if;
  if p_long and p_caps ? 'long_total' and v_long + p_risk > (p_caps->>'long_total')::numeric then return 'cap_total_long'; end if;
  if cardinality(coalesce(p_games, '{}')) > 0 and v_game + p_risk > (p_caps->>'game')::numeric then return 'game_cap'; end if;
  if cardinality(coalesce(p_legs, '{}')) > 0 and v_leg + p_risk > (p_caps->>'leg')::numeric then return 'leg_cap'; end if;
  if p_count_new then
    v := (sniper_day_exposure(d, lv)->>'filled')::numeric;
    if v + p_risk > (p_caps->>'daily_risk')::numeric then return 'daily_risk_cap'; end if;
    v_ph := sniper_hour_count(not lv, now() - interval '1 hour');
    if v_ph + 1 > (p_caps->>'per_hour')::numeric then return 'hourly_rate_cap'; end if;
  end if;
  return null;
end $function$
;

CREATE OR REPLACE FUNCTION public.sniper_reserve(p_row jsonb, p_caps jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r text; v_settle timestamptz := (p_row->>'settle_at')::timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('sniper_ledger'));
  update sniper_ledger set status = 'released', updated_at = now()
   where status = 'open' and combo_key = p_row->>'combo_key' and dry_run = coalesce((p_row->>'dry_run')::boolean, true) and release_at <= now() and phase not in ('accepted','filled');
  if exists (select 1 from sniper_ledger where rfq_id = p_row->>'rfq_id') then return 'duplicate'; end if;
  if exists (select 1 from sniper_open_rows(null, not coalesce((p_row->>'dry_run')::boolean, true)) where combo_key = p_row->>'combo_key') then return 'duplicate'; end if;
  r := sniper_cap_reason((p_row->>'risk')::numeric,
         array(select jsonb_array_elements_text(p_row->'games')),
         array(select jsonb_array_elements_text(p_row->'legs')), p_caps, null, true,
         sniper_is_long(v_settle, now(), (p_caps->>'short_settle_hours')::numeric));
  if r is not null then return r; end if;
  insert into sniper_ledger (rfq_id, combo_key, games, legs, status, phase, dry_run, risk, ev, roi, quote_yes,
      quote_american, fair_yes, fair_american, contracts, fee, maker_rate, market_ticker, release_at, settle_at)
  values (p_row->>'rfq_id', p_row->>'combo_key',
      array(select jsonb_array_elements_text(p_row->'games')), array(select jsonb_array_elements_text(p_row->'legs')),
      'open', coalesce(p_row->>'phase', 'reserved'), coalesce((p_row->>'dry_run')::boolean, true),
      (p_row->>'risk')::numeric, (p_row->>'ev')::numeric, (p_row->>'roi')::numeric, (p_row->>'quote_yes')::numeric,
      (p_row->>'quote_american')::integer, (p_row->>'fair_yes')::numeric, (p_row->>'fair_american')::integer,
      (p_row->>'contracts')::numeric, (p_row->>'fee')::numeric, (p_row->>'maker_rate')::numeric,
      p_row->>'market_ticker', (p_row->>'release_at')::timestamptz, v_settle);
  return 'ok';
exception when unique_violation then return 'duplicate';
end $function$
;
