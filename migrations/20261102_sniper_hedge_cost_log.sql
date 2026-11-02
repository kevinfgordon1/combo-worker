-- LOG-ONLY hedge-cost pricing for both Combo Snipers (Kevin Nov 2 2026). Quoting does not read these.
-- Run once in the Supabase SQL editor. Fast: nullable columns, no default, no backfill, no index
-- (catalog-only change; no table rewrite). lock_timeout makes it give up after 3s instead of
-- queueing behind a long query; if it times out, just run it again.
--   hedge       jsonb    at quote post, compact (~100 bytes): {"l":[[venue, cost, status], ...], "m": maker rate}
--                        per leg: best venue to BUY the leg (k kalshi, p polymarket, n novig, x prophetx),
--                        its fee-included cost, and a 4-letter status for kalshi/polymarket/novig/prophetx:
--                        o ok, s stale (>15s), d depth (too thin), t top-of-book only, a no ask,
--                        v overround (TD), m missing, f venue off. e.g. ["k",0.7244,"omsd"] = Novig stale.
--   hedge_prob  numeric  parlay hedge-cost probability (product of leg costs)
--   hedge_roi   numeric  hedge-cost edge, same formula as SNIPER_MIN_ROI, at the quoted price
--   hedge_fill  jsonb    full detail at confirm on fresh books (our price, accepted size): per leg venue,
--                        cost, American, and every venue's status, cost, age (ms); parlay p, roi, ev
-- The workers write these only on rows they already write (posted quotes, fills). Until this runs,
-- they skip the fields and log "[HEDGE-LOG] ... hedge columns missing" once.
set lock_timeout = '3s';
alter table public.sniper_ledger
  add column if not exists hedge jsonb,
  add column if not exists hedge_prob numeric,
  add column if not exists hedge_roi numeric,
  add column if not exists hedge_fill jsonb;
alter table public.poly_sniper_ledger
  add column if not exists hedge jsonb,
  add column if not exists hedge_prob numeric,
  add column if not exists hedge_roi numeric,
  add column if not exists hedge_fill jsonb;
notify pgrst, 'reload schema';
