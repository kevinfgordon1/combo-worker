-- Site Today uses created_at OR updated_at (aibetbuilder #58 dropped user_id).
-- Fill UPDATEs must stamp updated_at so a same-day fill of an older seen row
-- (stale filled_at / created_at) still appears on Today.
-- Run in the Supabase SQL editor if unhedged_rfqs already exists without this.

alter table public.unhedged_rfqs
  add column if not exists updated_at timestamptz;
