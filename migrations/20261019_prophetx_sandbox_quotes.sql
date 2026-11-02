-- prophetx-worker (SANDBOX ONLY): one small row per quoted parlay, updated in
-- place on confirm / finalize / settle. Declines are NOT written per RFQ; they
-- roll up into prophetx_sandbox_stats (one row per ET day). Service role only.
create table if not exists public.prophetx_sandbox_quotes (
  parlay_id        text primary key,
  created_at       timestamptz not null default now(),
  n_legs           smallint not null,
  legs             jsonb not null,            -- [{s: strike_id, t: team, p: fair prob, v: best venue, o: opp american}]
  stake            numeric,
  fair_american    integer,
  quote_american   integer,                   -- participant-side American we offered
  quote_p          double precision,
  max_risk         numeric,
  confirm_at       timestamptz,
  confirm_action   text,                      -- accept | reject
  confirm_reason   text,
  confirmed_price  numeric,                   -- as ProphetX sent it
  confirmed_qty    numeric,
  confirm_http     smallint,
  prob_error       text,                      -- invalid_probability etc. from the callback
  order_uuid       text,
  finalized_at     timestamptz,
  final_status     text,
  settled_at       timestamptz,
  settlement       text,
  profit           numeric
);
create index if not exists prophetx_sandbox_quotes_created_idx on public.prophetx_sandbox_quotes (created_at desc);
alter table public.prophetx_sandbox_quotes enable row level security;

create table if not exists public.prophetx_sandbox_stats (
  day        date primary key,
  counts     jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.prophetx_sandbox_stats enable row level security;

-- "Clean" quoted order: we accepted, ProphetX finalized it, and the leg
-- probabilities were accepted (no invalid_probability).
create or replace view public.prophetx_sandbox_clean as
  select count(*) filter (where confirm_action = 'accept' and final_status = 'finalized' and prob_error is null and confirm_http = 200) as clean_orders,
         count(*) as quoted,
         count(*) filter (where confirm_action is not null) as confirm_requests,
         count(*) filter (where confirm_action = 'reject') as rejects,
         count(*) filter (where prob_error is not null) as prob_errors
  from public.prophetx_sandbox_quotes;
revoke all on public.prophetx_sandbox_clean from anon, authenticated;
