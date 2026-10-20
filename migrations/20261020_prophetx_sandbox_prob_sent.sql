-- Per-confirm price_probability we sent (strike id + probability), its product and the mirror target.
alter table prophetx_sandbox_quotes
  add column if not exists prob_sent jsonb,
  add column if not exists prob_target double precision,
  add column if not exists prob_product double precision;
