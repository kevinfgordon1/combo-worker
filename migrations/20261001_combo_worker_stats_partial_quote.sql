-- Partial-quote (oversized RFQ) DRY-RUN counters for the current UTC hour.
-- Observability only; written by heartbeat.js. Nullable, no backfill.
alter table public.combo_worker_stats
  add column if not exists partial_quote jsonb;
comment on column public.combo_worker_stats.partial_quote is
  'COMBO_PARTIAL_QUOTE_OVERSIZED dry-run for the current UTC hour: mode, would_quote, clip_contracts, rfq_contracts, locks, venues{}';
