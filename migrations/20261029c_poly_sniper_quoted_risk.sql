-- Polymarket sniper ledger: keep the risk we QUOTED on every row. `risk` stays the counted open risk
-- (0 while a quote is only resting, see 20261029_poly_sniper_live.sql) because boot hydration feeds it
-- into the caps. Additive; the worker writes quoted_risk only once this column exists.
alter table public.poly_sniper_ledger add column if not exists quoted_risk numeric;
-- Optional backfill of rows written before the column existed (quoted size * (1 - our price)):
update public.poly_sniper_ledger
   set quoted_risk = round(contracts * (1 - buy_price), 6)
 where quoted_risk is null and contracts is not null and buy_price is not null;
