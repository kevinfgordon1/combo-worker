-- Unhedged RFQ shadow tape (not Combo Locks).
-- Persist in-scope unmatched Kalshi / Polymarket combo RFQs so a separate
-- dashboard can compare what we would quote vs what printed.
-- Worker writes with SUPABASE_SERVICE_KEY (bypasses RLS). No live quotes.
--
-- Run in the Supabase SQL editor (or psql) against the combo-worker project.

create table if not exists public.unhedged_rfqs (
  id uuid primary key default gen_random_uuid(),
  rfq_id text not null,
  venue text not null check (venue in ('kalshi', 'polymarket')),
  created_at timestamptz not null default now(),
  legs jsonb not null default '[]'::jsonb,
  contracts numeric,
  cash_size numeric,
  taker_yes_price numeric,
  taker_no_price numeric,
  taker_american integer,
  our_fair_american integer,
  our_quote_american integer,
  status text not null,
  skip_reason text,
  unique (venue, rfq_id)
);

create index if not exists unhedged_rfqs_created_at_idx
  on public.unhedged_rfqs (created_at desc);

create index if not exists unhedged_rfqs_venue_status_idx
  on public.unhedged_rfqs (venue, status);

alter table public.unhedged_rfqs enable row level security;

-- Dashboard read (logged-in users). Writes stay service-role only.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'unhedged_rfqs'
      and policyname = 'unhedged_rfqs_read'
  ) then
    create policy unhedged_rfqs_read on public.unhedged_rfqs
      for select to authenticated
      using (true);
  end if;
end $$;
