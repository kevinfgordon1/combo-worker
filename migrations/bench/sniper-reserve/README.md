Local benchmark for 20261023c (Postgres 17, 100k-row seed shaped like prod).
  psql -d sniperbench -f migrations/20261021_sniper_tables.sql (+ 20261021b, 20261022)
  bash run.sh OLD            # current functions
  psql -f ../../20261023c_sniper_reserve_fast.sql && bash run.sh NEW
  old_cap.sql = current sniper_cap_reason renamed _old for the 20k-case equivalence check.
  tight.pgb + inv.sql = 32 concurrent reserves at the real $5k/$1.5k/$750 caps; inv.sql must stay under caps.
