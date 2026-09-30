-- Read-only views over the paper MM tape (mm_paper_events). Safe to re-run.
-- Headline totals exclude legacy rows: pairs written before the kickoff
-- cutoff logic shipped (~2026-09-28) carry no `phase`, and pairs flagged
-- `legacy` by the engine (they consumed such a lot).

create or replace view public.mm_paper_pairs_v as
select
  id, created_at, game_id,
  (payload->>'qty')::numeric as qty,
  (payload->>'lockedProfit')::numeric as locked_profit,
  (payload->>'combinedCents')::numeric as combined_cents,
  (payload->>'phase') as phase,
  (payload->>'phase') is null or coalesce((payload->>'legacy')::boolean, false) as legacy
from public.mm_paper_events
where kind = 'pair';

create or replace view public.mm_paper_pnl_summary_v as
select
  (select coalesce(sum(locked_profit), 0) from public.mm_paper_pairs_v where not legacy) as headline_locked_profit,
  (select count(*) from public.mm_paper_pairs_v where not legacy) as headline_pairs,
  (select coalesce(sum(locked_profit), 0) from public.mm_paper_pairs_v where legacy) as legacy_locked_profit_excluded,
  (select count(*) from public.mm_paper_pairs_v where legacy) as legacy_pairs_excluded,
  (select coalesce(sum((payload->>'pnl')::numeric), 0) from public.mm_paper_events
     where kind = 'exit' and coalesce((payload->>'legacy')::boolean, false) = false) as exit_pnl,
  (select coalesce(sum((payload->>'realizedPnl')::numeric), 0) from public.mm_paper_events where kind = 'settle') as settled_realized_pnl,
  (select coalesce(sum((payload->>'legacyPnl')::numeric), 0) from public.mm_paper_events where kind = 'settle') as settled_legacy_pnl_excluded,
  (select count(*) from public.mm_paper_events where kind = 'settle') as settled_games;

create or replace view public.mm_paper_markouts_v as
select
  created_at, game_id, payload->>'team' as team, payload->>'venue' as venue,
  payload->>'horizon' as horizon,
  (payload->>'markoutCents')::numeric as markout_cents,
  (payload->>'markoutUsd')::numeric as markout_usd,
  (payload->>'adverse')::boolean as adverse
from public.mm_paper_events
where kind = 'markout';

alter view public.mm_paper_pairs_v set (security_invoker = on);
alter view public.mm_paper_pnl_summary_v set (security_invoker = on);
alter view public.mm_paper_markouts_v set (security_invoker = on);
