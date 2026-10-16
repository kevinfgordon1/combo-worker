-- No-boost PAPER tape: run tagging + trade-matching audit columns. Additive, nullable, safe to re-run.
-- Rows written before this migration have run_id NULL (legacy v1 run, kept for reference).
alter table public.noboost_paper_rfqs
  add column if not exists run_id text,
  add column if not exists rfq_contracts numeric,        -- RFQ requested contracts (null for dollar RFQs)
  add column if not exists rfq_target_cost numeric,      -- RFQ requested target cost $ (null for contract RFQs)
  add column if not exists quote_expires_at timestamptz, -- seen_at + quote lifetime; fills only credit trades in (seen_at, quote_expires_at]
  add column if not exists match_candidates integer,     -- in-window, size-consistent RFQs on this combo when the print matched
  add column if not exists match_ambiguous boolean,      -- >1 candidate or RFQ size unknown
  add column if not exists match_note text,
  add column if not exists size_ratio numeric,           -- print size / RFQ size (or notional / target cost)
  add column if not exists void_legs integer,            -- legs settled void/push
  add column if not exists push boolean;                 -- every leg void => P&L 0
alter table public.noboost_paper_stats add column if not exists run_id text;
create index if not exists noboost_paper_rfqs_run_idx on public.noboost_paper_rfqs (run_id, seen_at desc) where run_id is not null;
create index if not exists noboost_paper_stats_run_idx on public.noboost_paper_stats (run_id, created_at desc) where run_id is not null;
