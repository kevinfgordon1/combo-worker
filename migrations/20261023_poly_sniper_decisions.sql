-- Polymarket combo sniper — Phase 1 DRY RUN tape (poly-sniper/). Hypothetical decisions only:
-- nothing in this table was ever quoted. venue column lets Kalshi sniper_decisions + this table
-- show combined per-game exposure while caps stay per venue. Safe to re-run.
create table if not exists public.poly_sniper_decisions (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  rfq_id text not null,
  venue text not null default 'polymarket',
  dry_run boolean not null default true,
  source text,
  symbol text,
  action text not null,           -- 'quote' (would quote) | 'skip'
  reason text,
  leg_count int,
  legs jsonb,
  fair numeric, buy_price numeric, edge numeric, min_edge numeric,
  ev numeric, risk numeric, contracts numeric,
  qty_decimal numeric, cash_order_qty numeric,
  games text[],
  rfq_created_at timestamptz,
  decide_ms int, rfq_age_ms int, within_target boolean
);
create index if not exists poly_sniper_decisions_created_idx on public.poly_sniper_decisions (created_at desc);
create index if not exists poly_sniper_decisions_action_idx on public.poly_sniper_decisions (action, created_at desc);
create index if not exists poly_sniper_decisions_rfq_idx on public.poly_sniper_decisions (rfq_id);
alter table public.poly_sniper_decisions enable row level security;
