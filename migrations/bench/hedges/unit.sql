-- Unit checks for 20261023e/f (hedge-aware caps). Fresh DB with all sniper migrations applied. Raises on failure.
truncate sniper_ledger cascade;
create or replace function pg_temp.caps() returns jsonb language sql as $$
  select jsonb_build_object('total',10000,'long_total',5000,'short_settle_hours',32,'game',1500,'leg',750,'daily_risk',10000,'daily_loss',10000,'per_hour',1e9,'day_start',(now()-interval '12 hours')::text,'live',true) $$;
-- a live FILLED long-dated fill: Wilson + Marks (prod numbers): n 64.75, cost 52.7713, fee 0.0001, risk 52.77
create or replace function pg_temp.fill(id text, risk numeric, n numeric, cost numeric, game text, leg text) returns void language sql as $$
  insert into sniper_ledger (rfq_id, combo_key, games, legs, status, phase, dry_run, risk, release_at, settle_at, filled_contracts, filled_cost, filled_fee)
  values (id, 'c-'||id, array[game], array[leg], 'open', 'filled', false, risk, now()+interval '7 days', now()+interval '60 hours', n, cost, 0.0001) $$;
create or replace function pg_temp.rv(id text, risk numeric, game text, leg text) returns text language sql as $$
  select sniper_reserve(jsonb_build_object('rfq_id',id,'combo_key','c-'||id,'games',jsonb_build_array(game),'legs',jsonb_build_array(leg),
    'dry_run',false,'risk',risk,'release_at',(now()+interval '1 hour')::text,'settle_at',(now()+interval '60 hours')::text), pg_temp.caps()) $$;
do $$ declare r text; s jsonb; begin
  perform pg_temp.fill('wm', 52.77, 64.75, 52.7713, 'G1', 'L1');
  perform pg_temp.fill('big', 4900, 6000, 4900, 'G2', 'L2');
  s := sniper_open_split(true); assert (s->>'long')::numeric = 4952.77, 'gross long '||s;
  r := pg_temp.rv('x1', 60, 'G9', 'L9'); assert r = 'cap_total_long', 'no room before hedge '||r;
  -- full arb-out: $7.21 at FanDuel +798 -> locked both ways, net worst-case loss 0
  insert into sniper_hedges (rfq_id, book, american, stake) values ('wm', 'FanDuel', 798, 7.21);
  assert abs(sniper_hedged_risk(52.77,'filled',64.75,52.7713,0.0001, 7.21*7.98, 7.21)) < 1e-9, 'wm net 0';
  s := sniper_open_split(true); assert (s->>'long')::numeric = 4900, 'hedge frees 52.77 '||s;
  r := pg_temp.rv('x1', 60, 'G9', 'L9'); assert r = 'ok', 'room after hedge '||r;
  delete from sniper_ledger where rfq_id = 'x1';
  -- void hedge -> back to gross
  update sniper_hedges set status = 'void' where rfq_id = 'wm';
  s := sniper_open_split(true); assert (s->>'long')::numeric = 4952.77, 'void restores '||s;
  -- partial hedge: $3 at +798 -> hit loss 52.7714-23.94 = 28.8314
  update sniper_hedges set status = 'active', stake = 3 where rfq_id = 'wm';
  s := sniper_open_split(true); assert abs((s->>'long')::numeric - (4900 + 52.7714 - 23.94)) < 1e-6, 'partial '||s;
  -- over-hedge: $20 at +798 -> miss loss 20 - 11.9786 = 8.0214 ; hit is +106.8; counted = 8.0214 (never 0)
  update sniper_hedges set stake = 20 where rfq_id = 'wm';
  s := sniper_open_split(true); assert abs((s->>'long')::numeric - (4900 + 20 - (64.75 - 52.7714))) < 1e-6, 'over-hedge counts miss loss '||s;
  -- giant over-hedge can push counted ABOVE gross risk (conservative)
  update sniper_hedges set stake = 200 where rfq_id = 'wm';
  s := sniper_open_split(true); assert (s->>'long')::numeric > 4952.77, 'huge hedge raises risk '||s;
  -- negative odds: -150 stake 30 -> win 20
  update sniper_hedges set stake = 30, american = -150 where rfq_id = 'wm';
  assert abs(sniper_american_decimal(-150) - 1.6666666667) < 1e-6, 'dec -150';
  -- hedges on an UNFILLED (reserved) row never reduce risk
  insert into sniper_ledger (rfq_id, combo_key, games, legs, status, phase, dry_run, risk, release_at) values ('q', 'c-q', '{G3}', '{L3}', 'open', 'quoted', false, 100, now()+interval '1 hour');
  insert into sniper_hedges (rfq_id, book, american, stake) values ('q', 'FanDuel', 900, 50);
  assert (select risk from sniper_open_rows(null, true) where rfq_id = 'q') = 100, 'unfilled unchanged';
  -- per-game / per-leg use the net risk too
  delete from sniper_hedges where rfq_id = 'wm';
  update sniper_ledger set risk = 700, filled_cost = 700, filled_contracts = 870, games = '{G1}', legs = '{L1}' where rfq_id = 'wm';
  r := pg_temp.rv('x2', 60, 'G1', 'L1'); assert r = 'cap_total_long', 'still long-capped '||r;
  update sniper_ledger set risk = 50 where rfq_id = 'big'; update sniper_ledger set filled_cost = 50 where rfq_id = 'big';
  r := pg_temp.rv('x2', 60, 'G1', 'L1'); assert r = 'leg_cap', 'leg cap gross '||r;
  insert into sniper_hedges (rfq_id, book, american, stake) values ('wm', 'FanDuel', 400, 160); -- hit: -700.0001+640 = -60.0001 ; miss: 170-160 = 9.9999
  r := pg_temp.rv('x2', 60, 'G1', 'L1'); assert r = 'ok', 'leg room after hedge '||r;
  delete from sniper_ledger where rfq_id = 'x2';
  -- daily new risk: least(filled_cost, net)
  s := sniper_day_exposure(now() - interval '12 hours', true);
  assert abs((s->>'filled')::numeric - (60.0001 + 50)) < 1e-6, 'day filled net '||s;
  -- daily loss includes hedge P&L of settled fills: parlay hit -> Kalshi -700.0001, hedge +640 -> -60.0001
  update sniper_ledger set status = 'released', phase = 'settled', market_result = 'yes', realized_pnl = -700.0001, settled_at = now() where rfq_id = 'wm';
  assert sniper_hedge_pnl('wm', 'yes') = 640, 'hedge pnl yes';
  assert sniper_hedge_pnl('wm', 'no') = -160, 'hedge pnl no';
  assert sniper_cap_reason(1, '{}', '{}', jsonb_set(pg_temp.caps(), '{daily_loss}', '100'), null, false, false) is null, 'net day loss 60 < 100';
  assert sniper_cap_reason(1, '{}', '{}', jsonb_set(pg_temp.caps(), '{daily_loss}', '60'), null, false, false) = 'daily_loss_halt', 'net day loss 60 >= 60';
  raise notice 'hedges unit OK';
end $$;
