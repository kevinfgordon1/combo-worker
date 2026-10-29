-- Fill reconcile: confirmed-but-unbooked Polymarket Combo Locks quotes (order_id stamped on confirm,
-- status still unfilled). Kevin runs this in the Supabase SQL editor. Additive, tiny (a few hundred rows).
create index if not exists combo_submissions_poly_ordered_unfilled_idx
  on public.combo_submissions (user_id, created_at desc)
  where venue = 'polymarket' and quote_id is not null and order_id is not null and status not in ('filled', 'shadow');
