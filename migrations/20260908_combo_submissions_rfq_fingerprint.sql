-- Combo Locks History grouping for repeated identical RFQs.
-- Worker degrades if this column is missing (same as venue / skip_reason).
-- Run in the Supabase SQL editor if combo_submissions already exists without this.

alter table public.combo_submissions
  add column if not exists rfq_fingerprint text;
