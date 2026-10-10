-- Per-tester override: no fixed per-lock/day trade caps and no auto-funding
-- per-move/daily limits. The ONLY limit is the tester's own Amount to keep for
-- combos (combo_settings.autofund_cap_usd); blank/0 = nothing trades or moves.
alter table public.combo_live_users
  add column if not exists fund_unlimited boolean not null default false;

-- c.w.higgins1@gmail.com (Kevin approved 2026-10-09)
update public.combo_live_users
   set fund_unlimited = true, max_per_lock_usd = null, max_per_day_usd = null
 where user_id = '721c1166-be0b-4856-8a88-6de3a8b047b9';
