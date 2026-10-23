set -e; label=$1
psql -q -d sniperbench -f seed.sql
for c in 4 16 32; do echo "$label c=$c"; pgbench -n -d sniperbench -f mixed.pgb -c $c -j 4 -T 30 -r 2>&1 | grep -E "^tps|select sniper_reserve" | sed 's/ \+/ /g' | cut -c1-80; done
