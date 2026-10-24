-- Closing-line snapshot for sniper fills (EV drift tracker). One row per open filled leg, written ONCE
-- at/just before that leg's kickoff by the sniper (sniper/close-snapshot.js). Tiny: ~legs-per-day rows.
-- NOT applied automatically: run in the Supabase SQL editor when Kevin approves. Rollback below.
create table if not exists public.sniper_leg_close (
  leg_key     text primary key,          -- 'TICKER:side' (upper-case ticker)
  ticker      text not null,
  side        text not null default 'yes',
  kickoff_at  timestamptz,
  fair_yes    numeric,                   -- inverse-bet fair (best opposing price across venues, after fees); null = no price
  venue       text,                      -- venue that set the close fair
  depth_usd   numeric,
  captured_at timestamptz not null default now()
);
create index if not exists sniper_leg_close_captured_idx on public.sniper_leg_close (captured_at desc);
alter table public.sniper_leg_close enable row level security; -- service role only
-- rollback: drop table if exists public.sniper_leg_close;
