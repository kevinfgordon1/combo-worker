-- Per-lock pause: the worker stops quoting a paused lock (Kalshi + Polymarket) and cancels
-- its open quotes; fills and history are untouched. Independent of the global kill switch.
-- Safe to apply before or after the worker deploy: the worker treats a missing column as
-- "every lock enabled".
alter table public.combo_parlays add column if not exists paused boolean not null default false;
alter table public.combo_parlays add column if not exists paused_at timestamptz;
comment on column public.combo_parlays.paused is
  'True = Combo Locks tab paused this lock. Worker does not match/quote it on any venue and cancels its open quotes.';
