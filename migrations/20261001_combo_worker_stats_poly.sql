-- Polymarket US RFQ intake counters per heartbeat interval (observability only).
-- Written by heartbeat.js on each combo_worker_stats row; nullable, no backfill.
alter table public.combo_worker_stats
  add column if not exists poly jsonb;
comment on column public.combo_worker_stats.poly is
  'Poly RFQ intake for the last completed POLY heartbeat interval: seen, ws, rest, rest_only, crawl_*, candidates, matched, quoted, would_quote, declined, reasons{}';
