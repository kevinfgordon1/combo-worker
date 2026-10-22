-- Sniper daily new-risk cap counts FILLED cost only (Kevin, Oct 22 2026). Open quotes stay
-- bounded by the separate total / per-game / per-leg caps. One function feeds both the cap and
-- the runner's "filled today / pending" log lines so they can never disagree.
create or replace function public.sniper_day_exposure(p_day_start timestamptz, p_live boolean)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'filled', coalesce((select sum(filled_cost) from sniper_ledger
                         where dry_run = not p_live and created_at >= p_day_start and filled_contracts > 0), 0),
    'fills', (select count(*) from sniper_ledger
                where dry_run = not p_live and created_at >= p_day_start and filled_contracts > 0),
    'pending', coalesce((select sum(risk) from sniper_open_rows(null, p_live) where phase not in ('filled','settled')), 0))
$$;

create or replace function public.sniper_cap_reason(p_risk numeric, p_games text[], p_legs text[], p_caps jsonb, p_exclude text, p_count_new boolean)
returns text language plpgsql stable set search_path = public as $$
declare v numeric; g text; l text; d timestamptz := (p_caps->>'day_start')::timestamptz;
  lv boolean := coalesce((p_caps->>'live')::boolean, false);
begin
  select coalesce(sum(realized_pnl), 0) into v from sniper_ledger where settled_at >= d and dry_run = false;
  if -v >= (p_caps->>'daily_loss')::numeric then return 'daily_loss_halt'; end if;
  select coalesce(sum(risk), 0) into v from sniper_open_rows(p_exclude, lv);
  if v + p_risk > (p_caps->>'total')::numeric then return 'total_cap'; end if;
  foreach g in array coalesce(p_games, '{}') loop
    select coalesce(sum(risk), 0) into v from sniper_open_rows(p_exclude, lv) where g = any(games);
    if v + p_risk > (p_caps->>'game')::numeric then return 'game_cap'; end if;
  end loop;
  foreach l in array coalesce(p_legs, '{}') loop
    select coalesce(sum(risk), 0) into v from sniper_open_rows(p_exclude, lv) where l = any(legs);
    if v + p_risk > (p_caps->>'leg')::numeric then return 'leg_cap'; end if;
  end loop;
  if p_count_new then
    v := (sniper_day_exposure(d, lv)->>'filled')::numeric;
    if v + p_risk > (p_caps->>'daily_risk')::numeric then return 'daily_risk_cap'; end if;
    select count(*) into v from sniper_ledger where dry_run = not lv and created_at > now() - interval '1 hour';
    if v + 1 > (p_caps->>'per_hour')::numeric then return 'hourly_rate_cap'; end if;
  end if;
  return null;
end $$;

revoke all on function public.sniper_day_exposure(timestamptz, boolean) from public, anon, authenticated;
