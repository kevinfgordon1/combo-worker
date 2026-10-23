-- PREVIEW (not applied): make sniper_reserve / sniper_confirm_check fast under the global lock.
--
-- Why it slowed: every reserve holds the one global advisory lock while it runs two SEQ SCANS of
-- the whole sniper_ledger (≈100k rows, +≈18k rows/hour since every reserve inserts a row that is
-- later released, never deleted):
--   * hourly_rate_cap: count(*) where created_at > now()-1h      (~64 ms on prod, no index)
--   * daily_risk_cap: sum(filled_cost) where created_at >= day   (~44 ms on prod, no index)
-- plus 1 + #games + #legs separate passes over the open rows. All reserves are serialized on that
-- lock, so per-call time = throughput ceiling, and it gets worse every minute as the table grows.
--
-- Fix (same caps, same lock, same reason codes and check order):
--   1. Partial indexes for the two time-window checks.
--   2. hourly cap reads a trigger-kept per-minute counter + the one edge minute (exact count).
--   3. total / per-game / per-leg sums from ONE pass over the open rows.
-- The single global lock is KEPT on purpose: the $5k total cap spans every game, so per-game /
-- per-leg locks alone could let two reserves on different games both pass the total. Making the
-- critical section ~1 ms is what removes the queue.
--
-- Rollout: run the two CREATE INDEX CONCURRENTLY statements first, one at a time, outside a
-- transaction (Supabase SQL editor runs each statement separately), then the rest of this file.
-- Old buckets (>3h) are pruned by sniper_hour_buckets_prune (call from the settle loop or cron; optional).

create index concurrently if not exists sniper_ledger_live_created_idx
  on public.sniper_ledger (dry_run, created_at);
create index concurrently if not exists sniper_ledger_filled_created_idx
  on public.sniper_ledger (dry_run, created_at) include (filled_cost) where filled_contracts > 0;

-- Hourly-cap counter: per-minute insert counts kept by trigger (exact, see sniper_hour_count).
create table if not exists public.sniper_hour_buckets (
  dry_run boolean not null, minute timestamptz not null, n bigint not null default 0,
  primary key (dry_run, minute));
alter table public.sniper_hour_buckets enable row level security; -- service role only
create or replace function public.sniper_hour_bucket_trg() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    update sniper_hour_buckets set n = n - 1 where dry_run = old.dry_run and minute = date_trunc('minute', old.created_at);
  end if;
  if tg_op in ('INSERT','UPDATE') then
    insert into sniper_hour_buckets (dry_run, minute, n) values (new.dry_run, date_trunc('minute', new.created_at), 1)
      on conflict (dry_run, minute) do update set n = sniper_hour_buckets.n + 1;
  end if;
  return null;
end $$;
begin;
lock table public.sniper_ledger in share row exclusive mode; -- no inserts between trigger + backfill (blocks reserves for ~0.1s)
drop trigger if exists sniper_hour_bucket on public.sniper_ledger;
create trigger sniper_hour_bucket after insert or delete or update of created_at, dry_run on public.sniper_ledger
  for each row execute function public.sniper_hour_bucket_trg();
delete from public.sniper_hour_buckets;
insert into public.sniper_hour_buckets (dry_run, minute, n)
  select dry_run, date_trunc('minute', created_at), count(*) from public.sniper_ledger
   where created_at > now() - interval '3 hours' group by 1, 2;
commit;
-- Exact count of rows with created_at > p_since: whole minutes after p_since's minute from the
-- buckets, plus the partial edge minute straight from the index. Equals the old count(*).
create or replace function public.sniper_hour_count(p_dry boolean, p_since timestamptz)
returns bigint language sql stable set search_path = public as $$
  select coalesce((select sum(n) from sniper_hour_buckets where dry_run = p_dry and minute > date_trunc('minute', p_since)), 0)
       + (select count(*) from sniper_ledger where dry_run = p_dry and created_at > p_since
            and created_at < date_trunc('minute', p_since) + interval '1 minute')
$$;

create or replace function public.sniper_cap_reason(p_risk numeric, p_games text[], p_legs text[], p_caps jsonb, p_exclude text, p_count_new boolean)
returns text language plpgsql stable set search_path = public as $$
declare v numeric; d timestamptz := (p_caps->>'day_start')::timestamptz;
  lv boolean := coalesce((p_caps->>'live')::boolean, false);
  v_total numeric; v_game numeric; v_leg numeric; v_ph bigint;
begin
  select coalesce(sum(realized_pnl), 0) into v from sniper_ledger where settled_at >= d and dry_run = false;
  if -v >= (p_caps->>'daily_loss')::numeric then return 'daily_loss_halt'; end if;
  -- one pass: open exposure total, and the largest per-game / per-leg exposure among THIS row's games/legs
  with o as materialized (select risk, games, legs from sniper_open_rows(p_exclude, lv))
  select coalesce((select sum(risk) from o), 0),
         coalesce((select max(s) from (select sum(o.risk) s from (select distinct x from unnest(coalesce(p_games, '{}')) u(x)) g join o on g.x = any(o.games) group by g.x) a), 0),
         coalesce((select max(s) from (select sum(o.risk) s from (select distinct x from unnest(coalesce(p_legs, '{}')) u(x)) l join o on l.x = any(o.legs) group by l.x) b), 0)
    into v_total, v_game, v_leg;
  if v_total + p_risk > (p_caps->>'total')::numeric then return 'total_cap'; end if;
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

-- Optional housekeeping (buckets older than the 1h window are never read).
create or replace function public.sniper_hour_buckets_prune() returns void language sql set search_path = public as $$
  delete from sniper_hour_buckets where minute < now() - interval '3 hours' $$;
revoke all on function public.sniper_hour_buckets_prune() from public, anon, authenticated;
revoke all on function public.sniper_hour_count(boolean, timestamptz) from public, anon, authenticated;
