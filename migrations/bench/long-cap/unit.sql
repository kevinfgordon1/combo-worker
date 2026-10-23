-- Unit checks for 20261023d. Run on a fresh DB with all sniper migrations applied. Raises on failure.
truncate sniper_ledger;
create or replace function pg_temp.rv(id text, risk numeric, settle_h numeric) returns text language sql as $$
  select sniper_reserve(jsonb_build_object('rfq_id',id,'combo_key','c-'||id,'games',jsonb_build_array('G-'||id),'legs',jsonb_build_array('L-'||id),
    'dry_run',false,'risk',risk,'release_at',(now()+interval '1 hour')::text,
    'settle_at', case when settle_h is null then null else (now()+make_interval(secs=>settle_h*3600))::text end),
    jsonb_build_object('total',10000,'long_total',5000,'short_settle_hours',32,'game',1e9,'leg',1e9,'daily_risk',1e9,'daily_loss',1e9,'per_hour',1e9,'day_start',(now()-interval '12 hours')::text,'live',true)) $$;
do $$ declare r text; begin
  r := pg_temp.rv('a', 4900, 40);  assert r = 'ok', 'long 4900 '||r;
  r := pg_temp.rv('b', 200, 40);   assert r = 'cap_total_long', 'long over 5k '||r;
  r := pg_temp.rv('b2', 200, null);assert r = 'cap_total_long', 'null settle = long '||r;
  r := pg_temp.rv('c', 100, 32);   assert r = 'ok', 'exactly 32h is short '||r;
  r := pg_temp.rv('d', 4900, 10);  assert r = 'ok', 'short fills to 9900 '||r;
  r := pg_temp.rv('e', 200, 5);    assert r = 'total_cap', 'short over 10k '||r;
  r := pg_temp.rv('f', 100, 2);    assert r = 'ok', 'exactly 10000 ok '||r;
  r := pg_temp.rv('g', 1, 2);      assert r = 'total_cap', '10001 '||r;
  assert (sniper_open_split(true)->>'long')::numeric = 4900, 'split long';
  assert (sniper_open_split(true)->>'short')::numeric = 5100, 'split short';
  -- old callers (no long_total) keep total-only behaviour
  assert sniper_cap_reason(1, '{}', '{}', '{"total":20000,"daily_loss":1e9,"daily_risk":1e9,"per_hour":1e9}'::jsonb, null, false, true) is null, 'no long_total';
  raise notice 'unit OK';
end $$;
