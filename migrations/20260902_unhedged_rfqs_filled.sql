-- Fill-by-others columns on unhedged_rfqs (not Combo Locks).
-- Run in the Supabase SQL editor if unhedged_rfqs already exists without these.
-- status=filled means someone else printed; taker_* stays the original RFQ.

alter table public.unhedged_rfqs
  add column if not exists fill_yes_price numeric,
  add column if not exists fill_no_price numeric,
  add column if not exists fill_american integer,
  add column if not exists filled_at timestamptz;
