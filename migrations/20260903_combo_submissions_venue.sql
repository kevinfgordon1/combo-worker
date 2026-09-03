-- Combo Locks Miss tape venue (aibetbuilder #61).
-- Site chips read combo_submissions.venue (kalshi | polymarket). Unlabeled
-- rows default to Kalshi in the UI, so Poly quotes must stamp venue.
-- Run in the Supabase SQL editor if combo_submissions already exists without this.

alter table public.combo_submissions
  add column if not exists venue text;
