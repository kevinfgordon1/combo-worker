-- Sniper live path: lifecycle columns + DB-enforced (atomic) reservation and cap-at-confirm.
-- Run AFTER 20261021_sniper_tables.sql. Touches only sniper_* objects.
alter table public.sniper_ledger
  add column if not exists phase text not null default 'reserved'
    check (phase in ('dry_run','reserved','quoted','accepted','filled','settled','cancelled','declined','failed')),
  add column if not exists market_ticker text,
  add column if not exists quote_id text,
  add column if not exists order_id text,
  add column if not exists no_bid text,
  add column if not exists filled_contracts numeric not null default 0,
  add column if not exists filled_cost numeric not null default 0,
  add column if not exists filled_fee numeric not null default 0,
  add column if not exists fill_ids text[] not null default '{}',
  add column if not exists market_result text,
  add column if not exists realized_pnl numeric,
  add column if not exists settled_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
create index if not exists sniper_ledger_quote_idx on public.sniper_ledger (quote_id);
create index if not exists sniper_ledger_settled_idx on public.sniper_ledger (settled_at);

-- Exposure that still counts: open rows not past release_at, plus accepted/filled rows until settled.
-- Live and dry-run positions are tracked separately (p_live = which book), so dry-run history
-- never eats the live caps and vice versa.
create or replace function public.sniper_open_rows(p_exclude text, p_live boolean)
returns setof public.sniper_ledger language sql stable set search_path = public as $$
  select * from sniper_ledger
   where status = 'open' and dry_run = not p_live
     and (release_at > now() or phase in ('accepted','filled'))
     and (p_exclude is null or rfq_id <> p_exclude)
$$;

-- Cap check shared by reserve and confirm. p_caps: total, game, leg, daily_risk, daily_loss,
-- per_hour, day_start (ISO, ET midnight). Returns null when OK, else the reason.
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
    select coalesce(sum(risk), 0) into v from sniper_ledger where dry_run = not lv and created_at >= d and phase not in ('cancelled','declined','failed');
    if v + p_risk > (p_caps->>'daily_risk')::numeric then return 'daily_risk_cap'; end if;
    select count(*) into v from sniper_ledger where dry_run = not lv and created_at > now() - interval '1 hour';
    if v + 1 > (p_caps->>'per_hour')::numeric then return 'hourly_rate_cap'; end if;
  end if;
  return null;
end $$;

-- Atomic reserve: one global advisory lock serializes all sniper reservations, so two RFQs can
-- never both pass the caps. Duplicate rfq_id / open combo is refused by the PK / unique index.
create or replace function public.sniper_reserve(p_row jsonb, p_caps jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare r text;
begin
  perform pg_advisory_xact_lock(hashtext('sniper_ledger'));
  update sniper_ledger set status = 'released', updated_at = now()
   where status = 'open' and combo_key = p_row->>'combo_key' and dry_run = coalesce((p_row->>'dry_run')::boolean, true) and release_at <= now() and phase not in ('accepted','filled');
  if exists (select 1 from sniper_ledger where rfq_id = p_row->>'rfq_id') then return 'duplicate'; end if;
  if exists (select 1 from sniper_open_rows(null, not coalesce((p_row->>'dry_run')::boolean, true)) where combo_key = p_row->>'combo_key') then return 'duplicate'; end if;
  r := sniper_cap_reason((p_row->>'risk')::numeric,
         array(select jsonb_array_elements_text(p_row->'games')),
         array(select jsonb_array_elements_text(p_row->'legs')), p_caps, null, true);
  if r is not null then return r; end if;
  insert into sniper_ledger (rfq_id, combo_key, games, legs, status, phase, dry_run, risk, ev, roi, quote_yes,
      quote_american, fair_yes, fair_american, contracts, fee, maker_rate, market_ticker, release_at)
  values (p_row->>'rfq_id', p_row->>'combo_key',
      array(select jsonb_array_elements_text(p_row->'games')), array(select jsonb_array_elements_text(p_row->'legs')),
      'open', coalesce(p_row->>'phase', 'reserved'), coalesce((p_row->>'dry_run')::boolean, true),
      (p_row->>'risk')::numeric, (p_row->>'ev')::numeric, (p_row->>'roi')::numeric, (p_row->>'quote_yes')::numeric,
      (p_row->>'quote_american')::integer, (p_row->>'fair_yes')::numeric, (p_row->>'fair_american')::integer,
      (p_row->>'contracts')::numeric, (p_row->>'fee')::numeric, (p_row->>'maker_rate')::numeric,
      p_row->>'market_ticker', (p_row->>'release_at')::timestamptz);
  return 'ok';
exception when unique_violation then return 'duplicate';
end $$;

-- Cap-at-confirm (like COMBO_CAP_AT_CONFIRM): re-check caps with the accepted size, under the
-- same lock, excluding this row's reservation; on OK mark it accepted with the final risk.
create or replace function public.sniper_confirm_check(p_rfq text, p_risk numeric, p_caps jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare v_row sniper_ledger; r text;
begin
  perform pg_advisory_xact_lock(hashtext('sniper_ledger'));
  select * into v_row from sniper_ledger where rfq_id = p_rfq for update;
  if not found then return 'no_reservation'; end if;
  if v_row.status <> 'open' or v_row.phase <> 'quoted' then return 'bad_phase_' || v_row.phase; end if;
  r := sniper_cap_reason(p_risk, v_row.games, v_row.legs, p_caps, p_rfq, false);
  if r is not null then return r; end if;
  update sniper_ledger set phase = 'accepted', risk = greatest(p_risk, 0), updated_at = now() where rfq_id = p_rfq;
  return 'ok';
end $$;

revoke all on function public.sniper_reserve(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.sniper_confirm_check(text, numeric, jsonb) from public, anon, authenticated;
