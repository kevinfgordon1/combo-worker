-- Undo 20261102_sniper_hedge_cost_log.sql (drops the log-only hedge-cost columns and their data).
set lock_timeout = '3s';
alter table public.sniper_ledger
  drop column if exists hedge, drop column if exists hedge_prob, drop column if exists hedge_roi, drop column if exists hedge_fill;
alter table public.poly_sniper_ledger
  drop column if exists hedge, drop column if exists hedge_prob, drop column if exists hedge_roi, drop column if exists hedge_fill;
notify pgrst, 'reload schema';
