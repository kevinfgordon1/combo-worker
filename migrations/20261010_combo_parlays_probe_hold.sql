-- Check market price on a pending lock: short hold so the worker cancels the
-- lock's own quotes while the owner's probe RFQ is out. The worker ignores a
-- hold older than 30s (safety net); the API clears it when the probe ends.
alter table public.combo_parlays add column if not exists probe_hold_until timestamptz;
