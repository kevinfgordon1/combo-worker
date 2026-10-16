-- Per-leg probabilities used at pricing time (Combo Sniper audit).
alter table public.noboost_paper_rfqs add column if not exists leg_fairs jsonb;
