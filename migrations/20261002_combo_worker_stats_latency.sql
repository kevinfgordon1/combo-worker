-- Burst-latency telemetry: per-heartbeat quote latency histograms, late-post / rfq_closed /
-- stale-skip counters, WS reconnect counts by reason, resubscribe gap and event-loop lag.
alter table public.combo_worker_stats add column if not exists latency jsonb;
comment on column public.combo_worker_stats.latency is
  'Per-heartbeat latency snapshot (latency-stats.js): quote_ms / intake_ms / posted_age_ms histograms, late_posts, rfq_closed, stale_skipped, reconnects, resubscribe_gap_max_ms, loop_lag_ms.';
