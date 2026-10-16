-- Polymarket US parlay RFQs in the no-boost PAPER tape (Combo Sniper). Additive; existing rows become venue='kalshi'.
alter table public.noboost_paper_rfqs
  add column if not exists venue text not null default 'kalshi',
  add column if not exists poly_symbol text,
  add column if not exists poly_tick_size numeric,
  add column if not exists rfq_closed_at timestamptz,
  add column if not exists legs_kalshi jsonb,       -- Polymarket legs mapped to KXNFLGAME tickers (labels / worst-case engine)
  add column if not exists taker_side text,         -- from the print's aggressorSide (yes = SIDE_BUY)
  add column if not exists poly_trade_ids jsonb;    -- matched anonymous RFQ trade ids (first print sets traded_yes/traded_at)
create index if not exists noboost_paper_rfqs_venue_created_idx on public.noboost_paper_rfqs (venue, rfq_created_ts desc);
