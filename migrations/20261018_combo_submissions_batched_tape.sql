-- Batched tape matching for "checking who won" (combo_submissions).
-- Nullable columns only: the worker degrades (skips the field) if this is not applied yet.
alter table public.combo_submissions add column if not exists rfq_closed_at timestamptz;  -- rfq_deleted deleted_ts
alter table public.combo_submissions add column if not exists rfq_contracts numeric;      -- request size from rfq_created
alter table public.combo_submissions add column if not exists tape_trade_id text;         -- the print credited to this row (one row per print)

-- Already applied live on 2026-10-18 (PR #178 backlog reload). Kept here for the record.
create index concurrently if not exists combo_submissions_closed_live_pending_idx
  on public.combo_submissions (user_id, created_at desc)
  where skip_reason = 'rfq_closed_live' and tape_match is null;
