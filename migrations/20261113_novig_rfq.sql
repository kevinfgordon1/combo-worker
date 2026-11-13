-- Novig RFQ maker. Do not run this from the worker. Apply in the Supabase
-- SQL editor after review.
--
-- 1. combo_venue_holds.venue may be 'novig' so Kalshi and Polymarket see the
--    quote-time reserve through combo_venue_claim / the coordinator poll.
-- 2. combo_novig_shadow records RFQs that matched one lock: the price and
--    max stake we would have quoted, and later whether that price would have
--    won the execution (lower price wins).

do $$
declare r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'combo_venue_holds'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%venue%'
  loop
    execute format('alter table public.combo_venue_holds drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.combo_venue_holds
  add constraint combo_venue_holds_venue_check
  check (venue in ('kalshi', 'polymarket', 'novig'));

create table if not exists public.combo_novig_shadow (
  rfq_id            text primary key,
  seen_at           timestamptz not null default now(),
  outcome_ids       jsonb not null default '[]'::jsonb,
  parlay_id         text,
  user_id           uuid,
  label             text,
  would_price       text,
  would_american    integer,
  would_max_wager   numeric,
  would_collateral  numeric,
  min_wager         numeric,
  skip_reason       text,
  executed_price    text,
  executed_wager    numeric,
  would_win         boolean,
  detail            jsonb
);

alter table public.combo_novig_shadow enable row level security;
