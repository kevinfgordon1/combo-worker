# bash run.sh <db>: unit checks, then 32 concurrent reserves; split must stay <= 5000 long / 10000 total.
set -e; db=${1:-snipertest}; cd "$(dirname "$0")"
psql -q -v ON_ERROR_STOP=1 -d $db -f unit.sql
psql -q -d $db -c "truncate sniper_ledger"
pgbench -n -d $db -f tight.pgb -c 32 -j 8 -T 15 2>&1 | grep -E "^tps|latency average"
psql -At -d $db -c "select sniper_open_split(true)" | python3 -c "import json,sys;s=json.loads(sys.stdin.read());print(s);assert s['long']<=5000 and s['total']<=10000 and s['total']>9800,'invariant'; print('concurrency OK')"
