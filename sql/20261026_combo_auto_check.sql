-- Server-side Combo Locks auto market check (combo-worker lock-auto-check.js, COMBO_AUTO_CHECK=1).
-- Kevin runs this in the Supabase SQL editor. Additive + idempotent; safe before or after deploy.
alter table public.combo_parlays
  add column if not exists auto_check_at timestamptz,
  add column if not exists auto_check_missed integer,            -- quotes with no fill when checked
  add column if not exists auto_check_our_american integer,      -- our fill_american at check time
  add column if not exists auto_check_best_american integer,     -- best other seller (same seller-side basis)
  add column if not exists auto_check_best_no_bid numeric,
  add column if not exists auto_check_competitors integer,
  add column if not exists auto_check_result text,               -- win | tie | lose | none | error
  add column if not exists auto_check_error text;
-- Existing RLS on combo_parlays (owner reads own rows) already covers these columns.
