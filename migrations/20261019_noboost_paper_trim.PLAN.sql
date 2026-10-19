-- noboost_paper_rfqs storage trim — PLAN ONLY. NOT APPLIED. Run step by step, with Kevin's OK,
-- AFTER the poly-rfq.js write trim (this PR) is deployed to noboost-paper.
-- Nothing in rfq_hourly / rfq_daily_et reads this table (they come from noboost_paper_stats,
-- combo_worker_stats and combo_fills), so their history is untouched by every step below.
-- combo_sniper_traded (trigger-synced copy of every traded row) is also untouched.

-- STEP 1: new table, same columns, only the indexes something uses.
create table public.noboost_paper_rfqs_new (like public.noboost_paper_rfqs including defaults);
alter table public.noboost_paper_rfqs_new add primary key (rfq_id);
create index on public.noboost_paper_rfqs_new (rfq_created_ts desc);
create index on public.noboost_paper_rfqs_new (primary_fill, settled);   -- store.loadOpenFills
alter table public.noboost_paper_rfqs_new enable row level security;   -- same as today: service key only

-- STEP 2: copy what is worth keeping, one day per statement (small batches, no long lock).
--   kept = every non-Polymarket row (Kalshi is already sampled) + Polymarket rows that are NOT
--   no_trade/pending (traded, taker_no, accepted_not_filled) + a 2% hash sample of Polymarket no_trade.
-- Repeat for each ET day from 2026-10-05 (14-day retention) to today:
insert into public.noboost_paper_rfqs_new
select * from public.noboost_paper_rfqs
where rfq_created_ts >= '2026-10-18 00:00-04' and rfq_created_ts < '2026-10-19 00:00-04'
  and (venue is distinct from 'polymarket'
       or outcome not in ('no_trade','pending')
       or abs(hashtext(rfq_id)) % 100 < 2)
on conflict (rfq_id) do nothing;

-- STEP 3: swap (seconds). Pause noboost-paper first, catch up the last few minutes, swap, move trigger, resume.
begin;
  insert into public.noboost_paper_rfqs_new select * from public.noboost_paper_rfqs
    where rfq_created_ts >= now() - interval '1 hour'
      and (venue is distinct from 'polymarket' or outcome not in ('no_trade','pending') or abs(hashtext(rfq_id)) % 100 < 2)
    on conflict (rfq_id) do nothing;
  alter table public.noboost_paper_rfqs rename to noboost_paper_rfqs_old;
  alter table public.noboost_paper_rfqs_new rename to noboost_paper_rfqs;
  drop trigger combo_sniper_traded_sync on public.noboost_paper_rfqs_old;
  -- recreate with the exact definition from aibetbuilder supabase/migrations/20261016150000_combo_sniper_traded.sql
  create trigger combo_sniper_traded_sync after insert or update on public.noboost_paper_rfqs
    for each row execute function public.combo_sniper_traded_sync();
commit;

-- STEP 4 (after a day of checks): DROP frees the 18 GB instantly; a DELETE would not.
-- drop table public.noboost_paper_rfqs_old;

-- STEP 5: retention — raw rows older than 14 days (Kevin, Oct 19) roll off nightly in small batches.
-- select cron.schedule('noboost_paper_retention', '15 4 * * *', $$
--   delete from public.noboost_paper_rfqs where rfq_id in (
--     select rfq_id from public.noboost_paper_rfqs
--     where rfq_created_ts < now() - interval '14 days' and coalesce(primary_fill,false) = false
--     limit 50000) $$);
