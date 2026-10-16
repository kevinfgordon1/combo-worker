-- PM live inverse fair (Combo Sniper fair option) for the no-boost PAPER tape. Additive, nullable.
alter table public.noboost_paper_rfqs
  add column if not exists fair_pm_inverse_american integer,
  add column if not exists pm_inverse_reason text,
  add column if not exists pm_inverse_legs jsonb;
