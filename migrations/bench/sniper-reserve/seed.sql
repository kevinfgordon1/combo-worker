truncate sniper_ledger;
insert into sniper_ledger (rfq_id, combo_key, games, legs, status, phase, dry_run, risk, created_at, release_at, filled_contracts, filled_cost)
select 'seed-'||i, 'c-'||i, array['G'||(i%40), 'G'||((i+7)%40)], array['L'||(i%300), 'L'||((i+13)%300), 'L'||((i+101)%300)],
  'released', case when i%6=0 then 'failed' else 'cancelled' end, false, 20 + (i%150),
  now() - ((100000-i) * interval '200 ms'), now() - ((100000-i) * interval '200 ms') + interval '80 s', 0, 0
from generate_series(1,100000) i;
-- 90 counting open rows (some filled), like prod
insert into sniper_ledger (rfq_id, combo_key, games, legs, status, phase, dry_run, risk, created_at, release_at, filled_contracts, filled_cost)
select 'open-'||i, 'oc-'||i, array['G'||(i%40)], array['L'||(i%300),'L'||((i+5)%300)], 'open',
  case when i%2=0 then 'filled' else 'quoted' end, false, 10, now() - interval '10 min', now() + interval '6 hours',
  case when i%2=0 then 5 else 0 end, case when i%2=0 then 2 else 0 end
from generate_series(1,90) i;
vacuum analyze sniper_ledger;
do $$ begin if to_regclass('public.sniper_hour_buckets') is not null then
  delete from sniper_hour_buckets;
  insert into sniper_hour_buckets select dry_run, date_trunc('minute', created_at), count(*) from sniper_ledger group by 1,2;
end if; end $$;
