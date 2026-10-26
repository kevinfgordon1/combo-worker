-- One row per app: Combo Locks publishes its live Kalshi write usage every ~2s so the
-- sniper can borrow only idle reserved write slots. Service role only.
create table if not exists public.kalshi_write_lane (
  app text primary key,
  ts timestamptz not null default now(),
  active_locks int not null default 0,
  writes_10s int not null default 0
);
alter table public.kalshi_write_lane enable row level security;
revoke all on public.kalshi_write_lane from anon, authenticated;
