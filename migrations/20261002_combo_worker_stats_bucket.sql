-- Latest Kalshi bucket balances per heartbeat for the Combo Locks readout:
-- main_cents (shard 0 cash), combo_cash_cents (shard 1 available), combo_positions_cents
-- (shard 1 open-position value), ceiling_cents / target_cents / floor_cents, gameday, at.
-- Optional: heartbeat drops just this column if it is not migrated yet.
alter table public.combo_worker_stats add column if not exists bucket jsonb;
comment on column public.combo_worker_stats.bucket is
  'bucket-manager snapshot (cents): main_cents, combo_cash_cents, combo_positions_cents, ceiling_cents (cash only), target_cents, floor_cents, gameday, at.';
