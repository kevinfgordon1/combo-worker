select 'total', sum(risk) from sniper_open_rows(null,true) where rfq_id like 't-%'
union all select 'max_game', max(s) from (select g, sum(risk) s from sniper_open_rows(null,true), unnest(games) g where rfq_id like 't-%' group by g) a
union all select 'max_leg', max(s) from (select g, sum(risk) s from sniper_open_rows(null,true), unnest(legs) g where rfq_id like 't-%' group by g) a
union all select 'rows', count(*) from sniper_open_rows(null,true) where rfq_id like 't-%';
