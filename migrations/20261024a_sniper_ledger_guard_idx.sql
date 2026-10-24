-- sniper-guard.js looks up sniper_ledger by order_id and by market_ticker
-- (quote-watcher, live-runner, fills-reader). Neither column was indexed, so
-- each lookup seq-scanned the ~500 MB table (~1.2-1.8 s, ~1,900 calls since
-- stats reset, top two queries by disk reads). That IO starves every other
-- PostgREST read, incl. Promo's odds_cache / event_odds_cache loads.
-- Run each statement on its own (CONCURRENTLY cannot run in a transaction),
-- at a quiet hour, from a session without a short statement_timeout.
create index concurrently if not exists sniper_ledger_order_id_idx
  on public.sniper_ledger (order_id) where order_id is not null;
create index concurrently if not exists sniper_ledger_market_ticker_idx
  on public.sniper_ledger (market_ticker) where market_ticker is not null;
