-- Combo Sniper shadow tape (sniper/shadow.js). One row per RFQ the sniper
-- priced at SNIPER_SHADOW_MIN_EDGE, plus the quote at the live minimum.
-- Nothing in this table was sent to Kalshi or Polymarket.
--
-- NOT applied by the worker. Run in the Supabase SQL editor when Kevin approves.
-- Rollback: drop table if exists public.sniper_shadow_quotes;
create table if not exists public.sniper_shadow_quotes (
  id bigserial primary key,
  seen_at timestamptz not null,
  created_at timestamptz not null default now(),
  rfq_id text not null,
  venue text not null check (venue in ('kalshi', 'polymarket')),
  market_ticker text,
  legs jsonb not null,
  fair_yes numeric,
  fair_american integer,
  min_edge_shadow numeric not null,
  min_edge_live numeric,
  quote_yes_shadow numeric,
  quote_american_shadow integer,
  quote_yes_live numeric,
  quote_american_live integer,
  contracts numeric,
  contracts_live numeric,
  fee_shadow numeric,
  fee_live numeric,
  best_competing_yes numeric,
  best_competing_american integer,
  filled boolean,
  trade_yes numeric,
  trade_american integer,
  rfq_age_ms integer
);
create unique index if not exists sniper_shadow_quotes_venue_rfq_uq
  on public.sniper_shadow_quotes (venue, rfq_id);
create index if not exists sniper_shadow_quotes_seen_idx
  on public.sniper_shadow_quotes (seen_at desc);
alter table public.sniper_shadow_quotes enable row level security;
-- service role only; no client policies
