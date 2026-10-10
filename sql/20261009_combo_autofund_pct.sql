-- Combo Locks: "Amount to keep for combos" becomes a percentage of the tester's
-- total Kalshi cash (Default + Combos), recomputed by combo-worker every check.
--   autofund_pct null  = 90% (default for every tester, including new ones)
--   autofund_pct 0     = off: nothing moves or trades
--   autofund_pct 1-100 = that share of total cash
-- autofund_cap_usd stays as a legacy dollar cap: used only when autofund_pct is
-- null and a dollar value was saved. As of 2026-10-09 no tester has one.
-- Additive only: no data is changed, kill switches untouched.
alter table public.combo_settings
  add column if not exists autofund_pct numeric(5,2)
  check (autofund_pct is null or (autofund_pct >= 0 and autofund_pct <= 100));

comment on column public.combo_settings.autofund_pct is
  'Tester Amount to keep for combos, % of total Kalshi cash. null = 90%, 0 = off.';
