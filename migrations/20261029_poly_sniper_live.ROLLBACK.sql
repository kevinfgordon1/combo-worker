-- Rollback for 20261029_poly_sniper_live.sql. Only after the sniper is off and has no open fills.
drop table if exists public.poly_sniper_ledger;
drop table if exists public.poly_sniper_control;
