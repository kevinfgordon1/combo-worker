-- Isolated Auto-Sniper tables. Written ONLY by the "sniper" Railway service; no other job
-- reads or writes them. Run once in the Supabase SQL editor before starting the service.
create table if not exists public.sniper_ledger (
  rfq_id text primary key,
  combo_key text not null,
  games text[] not null default '{}',
  legs text[] not null default '{}',
  status text not null default 'open' check (status in ('open', 'released')),
  dry_run boolean not null default true,
  risk numeric not null,
  ev numeric, roi numeric,
  quote_yes numeric, quote_american integer,
  fair_yes numeric, fair_american integer,
  contracts numeric, fee numeric, maker_rate numeric,
  created_at timestamptz not null default now(),
  release_at timestamptz not null
);
-- no double dipping: one OPEN position per combo
create unique index if not exists sniper_ledger_open_combo_uq on public.sniper_ledger (combo_key, dry_run) where status = 'open';
create index if not exists sniper_ledger_open_idx on public.sniper_ledger (status, release_at);
create table if not exists public.sniper_decisions (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  rfq_id text,
  action text not null,
  reason text,
  details jsonb
);
create index if not exists sniper_decisions_created_idx on public.sniper_decisions (created_at desc);
alter table public.sniper_ledger enable row level security;   -- service role only; no client policies
alter table public.sniper_decisions enable row level security;
-- Release expired positions (optional cron; the service also ignores release_at < now()):
-- update public.sniper_ledger set status='released' where status='open' and release_at < now();
