-- Hedge-aware sniper caps (Kevin, Oct 23 2026). APPLY ON MERGE ONLY (changes live cap math).
-- Requires 20261023e_sniper_hedges_table.sql. Rollback: 20261023f_sniper_hedges_caps.ROLLBACK.sql.
--
-- An open FILLED row with >= 1 active hedge in sniper_hedges counts at its NET WORST-CASE LOSS:
--   R = filled_cost + filled_fee, n = filled_contracts, per hedge stake S at decimal D
--   hit  = -R + sum(S*(D-1))      miss = (n - R) - sum(S)
--   net  = greatest(0, -least(hit, miss))
-- Exactly the real worst case (never lower), so a hedge can only free room it really removes; an
-- over-sized hedge raises the counted risk. Unhedged / unfilled rows keep their ledger risk unchanged.
-- Applied in ONE place, sniper_open_rows, so total / long ($5k, 32h rule) / per-game / per-leg caps,
-- sniper_open_split and pending all see it. Daily new-risk (filled today) uses least(filled_cost, net);
-- daily loss adds hedge P&L of fills settled today. Same single advisory lock; no new locks.

create or replace function public.sniper_american_decimal(a numeric)
returns numeric language sql immutable as $$
  select case when a >= 100 then 1 + a / 100 when a <= -100 then 1 + 100 / -a else null end
$$;

-- Net worst-case loss of a fill after its hedges (win = sum S*(D-1), stake = sum S).
create or replace function public.sniper_hedged_risk(p_risk numeric, p_phase text, p_n numeric, p_cost numeric, p_fee numeric, p_win numeric, p_stake numeric)
returns numeric language sql immutable as $$
  select case when p_stake is null or p_stake <= 0 or p_phase <> 'filled' or coalesce(p_n, 0) <= 0 then p_risk
    else greatest(0,
      (coalesce(p_cost, 0) + coalesce(p_fee, 0)) - p_win,                 -- parlay hits
      p_stake - (p_n - (coalesce(p_cost, 0) + coalesce(p_fee, 0))))       -- parlay misses
  end
$$;

create or replace function public.sniper_open_rows(p_exclude text, p_live boolean)
returns setof public.sniper_ledger language sql stable set search_path = public as $$
  select case when h.stake is null then l
    else jsonb_populate_record(l, jsonb_build_object('risk',
      sniper_hedged_risk(l.risk, l.phase, l.filled_contracts, l.filled_cost, l.filled_fee, h.win, h.stake))) end
  from sniper_ledger l
  left join (select rfq_id, sum(stake * (sniper_american_decimal(american) - 1)) win, sum(stake) stake
               from sniper_hedges where status = 'active' group by rfq_id) h on h.rfq_id = l.rfq_id
   where l.status = 'open' and l.dry_run = not p_live
     and (l.release_at > now() or l.phase in ('accepted','filled'))
     and (p_exclude is null or l.rfq_id <> p_exclude)
$$;

-- Hedge P&L once the Kalshi parlay settled ('yes' = parlay hit = book bet wins).
create or replace function public.sniper_hedge_pnl(p_rfq text, p_result text)
returns numeric language sql stable set search_path = public as $$
  select coalesce(sum(case p_result when 'yes' then stake * (sniper_american_decimal(american) - 1) when 'no' then -stake else 0 end), 0)
    from sniper_hedges where rfq_id = p_rfq and status = 'active'
$$;

create or replace function public.sniper_day_exposure(p_day_start timestamptz, p_live boolean)
returns jsonb language sql stable set search_path = public as $$
  with f as (
    select l.filled_cost, sniper_hedged_risk(l.filled_cost + l.filled_fee, l.phase, l.filled_contracts, l.filled_cost, l.filled_fee, h.win, h.stake) net, h.stake
      from sniper_ledger l
      left join (select rfq_id, sum(stake * (sniper_american_decimal(american) - 1)) win, sum(stake) stake
                   from sniper_hedges where status = 'active' group by rfq_id) h on h.rfq_id = l.rfq_id
     where l.dry_run = not p_live and l.created_at >= p_day_start and l.filled_contracts > 0)
  select jsonb_build_object(
    'filled', coalesce((select sum(case when stake is null then filled_cost else least(filled_cost, net) end) from f), 0),
    'fills', (select count(*) from f),
    'pending', coalesce((select sum(risk) from sniper_open_rows(null, p_live) where phase not in ('filled','settled')), 0))
$$;

create or replace function public.sniper_cap_reason(p_risk numeric, p_games text[], p_legs text[], p_caps jsonb, p_exclude text, p_count_new boolean, p_long boolean default true)
returns text language plpgsql stable set search_path = public as $$
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
end $$;


revoke all on function public.sniper_american_decimal(numeric) from public, anon, authenticated;
revoke all on function public.sniper_hedged_risk(numeric, text, numeric, numeric, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function public.sniper_open_rows(text, boolean) from public, anon, authenticated;
revoke all on function public.sniper_hedge_pnl(text, text) from public, anon, authenticated;
revoke all on function public.sniper_day_exposure(timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.sniper_cap_reason(numeric, text[], text[], jsonb, text, boolean, boolean) from public, anon, authenticated;
