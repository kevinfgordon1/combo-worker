-- Polymarket loss tape: one row per Polymarket RFQ we quoted that closed without filling us.
-- Written by poly-worker (service role) from the anonymous RFQ trade prints on its existing RFQ websocket
-- (no participant ids exist, so this is "what price won", never "who won"). Run once in the Supabase SQL editor.
create table if not exists public.poly_lost_quotes (
  rfq_id               text        primary key,
  venue                text        not null default 'polymarket',
  symbol               text,                         -- combo symbol (prints are matched on this)
  outcome              text        not null,         -- lost_to_print | no_print (requester took no one)
  quote_id             text,
  parlay_id            text,
  label                text,
  rfq_created_at       timestamptz,
  rfq_closed_at        timestamptz,
  close_seen           boolean     not null default false,
  rfq_contracts        numeric,                      -- qty RFQ size
  rfq_cash             numeric,                      -- cash RFQ size ($)
  our_buy_price        numeric,                      -- our YES price (0..1)
  our_american         integer,
  our_contracts        numeric,
  won_price            numeric,                      -- first matching print's YES price
  won_american         integer,
  won_contracts        numeric,                      -- prints within 3s of the first, summed
  won_side             text,                         -- taker side of the print: yes | no | unknown
  won_at               timestamptz,
  gap                  numeric,                      -- our_buy_price − won_price (> 0: we were more expensive)
  gap_cents            numeric,
  trade_ids            text[],
  fill_groups          integer,
  prints_in_window     integer,
  size_mismatch_prints integer,
  other_open_requests  integer     not null default 0,
  ambiguous            boolean     not null default false, -- other same-combo RFQs open, >1 fill time, or unknown size
  created_at           timestamptz not null default now()
);
create index if not exists poly_lost_quotes_created_idx on public.poly_lost_quotes (rfq_created_at desc);
create index if not exists poly_lost_quotes_parlay_idx on public.poly_lost_quotes (parlay_id, rfq_created_at desc);

alter table public.poly_lost_quotes enable row level security;
-- No policies: only the service role (poly-worker) reads/writes.
