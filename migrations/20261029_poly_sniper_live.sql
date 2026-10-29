-- Polymarket sniper LIVE (preview, Kevin Oct 29). Apply BEFORE deploying a poly-worker build with
-- POLY_SNIPER_DRY_RUN=0. Additive only: two new tables, nothing existing is touched.
--
-- poly_sniper_control: the runtime on/off switch (one row, id=1). Default OFF. poly-worker polls it
-- every few seconds, so flipping it needs no restart. Turning it off deletes every open sniper quote.
--   turn on:  update public.poly_sniper_control set live = true,  updated_at = now(), updated_by = 'kevin' where id = 1;
--   turn off: update public.poly_sniper_control set live = false, updated_at = now(), updated_by = 'kevin' where id = 1;
create table if not exists public.poly_sniper_control (
  id smallint primary key default 1 check (id = 1),
  live boolean not null default false,
  note text,
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into public.poly_sniper_control (id, live, note) values (1, false, 'created off; flip live=true to quote')
  on conflict (id) do nothing;
alter table public.poly_sniper_control enable row level security;

-- poly_sniper_ledger: one row per LIVE sniper quote posted on Polymarket (quote_id is the venue id).
-- Only phases accepted/confirming/confirmed/filled count toward caps (resting quotes count $0);
-- risk = worst-case loss of what actually filled (filled_contracts * (1 - buy_price)), or of the
-- accepted size while the confirm/execution is in flight.
create table if not exists public.poly_sniper_ledger (
  quote_id text primary key,
  rfq_id text not null,
  symbol text,
  combo_key text,
  games text[],
  legs text[],
  leg_detail jsonb,
  phase text not null default 'quoted', -- quoted | accepted | confirmed | filled | declined | cancelled | replaced | expired | settled
  buy_price numeric,
  fair numeric,
  edge numeric,
  min_edge numeric,
  contracts numeric,          -- size we quoted (estimate for cash RFQs)
  accepted_contracts numeric, -- venue size on accept
  filled_contracts numeric not null default 0,
  filled_cost numeric not null default 0, -- premium received (contracts * buy_price)
  risk numeric not null default 0,        -- counted open risk (see above)
  order_id text,
  fill_ids text[] not null default '{}',
  settle_at timestamptz,
  decline_reason text,
  cancel_reason text,
  market_result text,         -- 'combo_won' (we lose) | 'combo_lost' (we win)
  realized_pnl numeric,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  confirmed_at timestamptz,
  filled_at timestamptz,
  settled_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists poly_sniper_ledger_open_idx on public.poly_sniper_ledger (phase) where phase in ('quoted', 'accepted', 'confirmed', 'filled');
create index if not exists poly_sniper_ledger_rfq_idx on public.poly_sniper_ledger (rfq_id);
create index if not exists poly_sniper_ledger_settled_idx on public.poly_sniper_ledger (settled_at) where settled_at is not null;
alter table public.poly_sniper_ledger enable row level security;
