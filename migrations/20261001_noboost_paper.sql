-- No-boost RFQ combo quoter: PAPER tape (shadow only; nothing here ever posts a quote).
-- Written by noboost/runner.js with SUPABASE_SERVICE_KEY. Safe to re-run.
-- All odds columns are AMERICAN odds; *_yes columns are the YES price in dollars per $1 payout.
create table if not exists public.noboost_paper_rfqs (
  rfq_id text primary key,
  created_at timestamptz not null default now(),
  rfq_created_ts timestamptz,
  seen_at timestamptz,
  detect_lag_ms integer,
  rfq_status text,
  market_ticker text,
  n_legs integer,
  legs jsonb,
  contracts numeric,
  -- fair prices (American)
  fair_mid_american integer,
  fair_inverse_american integer,
  fair_ref_american integer,
  lock_american integer,
  -- PRIMARY: margin over mid, lock guardrail OFF
  quote_primary_american integer,
  quote_primary_yes numeric,
  primary_action text,
  primary_reason text,
  primary_pulled text,
  -- COUNTERFACTUAL: same, lock guardrail ON
  quote_lock_american integer,
  quote_lock_yes numeric,
  lock_action text,
  lock_reason text,
  lock_pulled text,
  margin numeric,
  -- latency / staleness on the RFQ path
  decision_ms numeric,
  max_leg_age_ms integer,
  leg_ages_ms jsonb,
  -- what actually traded on this combo market after the RFQ
  outcome text,                 -- pending | traded | taker_no | no_trade
  traded_yes numeric,
  traded_american integer,
  traded_contracts numeric,
  traded_at timestamptz,
  primary_beat text,            -- win | tie | no
  lock_beat text,
  -- simulated paper position (a "fill" = our quote strictly beat the print and was not pulled)
  primary_fill boolean default false,
  primary_position jsonb,       -- {max_loss, premium, ev_vs_mid, total_after, game_after, util, caps_ok, reason}
  lock_fill boolean default false,
  lock_position jsonb,
  settled boolean default false,
  hit boolean,
  primary_pnl numeric,
  lock_pnl numeric
);
create index if not exists noboost_paper_rfqs_created_idx on public.noboost_paper_rfqs (rfq_created_ts desc);
create index if not exists noboost_paper_rfqs_outcome_idx on public.noboost_paper_rfqs (outcome);
create index if not exists noboost_paper_rfqs_fill_idx on public.noboost_paper_rfqs (primary_fill, settled);

create table if not exists public.noboost_paper_stats (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  payload jsonb not null
);
create index if not exists noboost_paper_stats_created_idx on public.noboost_paper_stats (created_at desc);
alter table public.noboost_paper_rfqs enable row level security;
alter table public.noboost_paper_stats enable row level security;
