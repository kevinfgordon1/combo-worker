-- PROMO variant (trusted-book consensus fair) columns for the no-boost PAPER tape. Additive, nullable.
alter table public.noboost_paper_rfqs
  add column if not exists fair_promo_american integer,
  add column if not exists fair_promo_best_american integer,
  add column if not exists quote_promo_american integer,
  add column if not exists quote_promo_yes numeric,
  add column if not exists promo_action text,
  add column if not exists promo_reason text,
  add column if not exists promo_pulled text,
  add column if not exists promo_beat text,
  add column if not exists promo_fill boolean default false,
  add column if not exists promo_position jsonb,
  add column if not exists promo_pnl numeric,
  add column if not exists promo_n_books integer[],
  add column if not exists promo_max_age_ms integer;
