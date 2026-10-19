# Multi-core RFQ matching (PREVIEW, off by default)

## What's in this branch
- `match-pool.js` / `match-worker.js`: worker_threads matcher pool (`COMBO_MATCH_THREADS=0|N|auto`, default 0 = off).
  Main thread keeps Kalshi sockets + needle fast-drop, hands surviving `rfq_created` frames to threads (round-robin);
  threads parse/normalize/match against a lock snapshot; only matches come back. The main thread re-resolves the lock
  by id against current locks and runs the existing quote path, so it remains the ONLY owner of reservations/sends
  (no double quotes). Not yet wired into live-runner.js (that is the next step if approved).
- `bench/match-bench.js`: replays synthetic rfq_created frames at a fixed rate vs 90 locks (`bench/results-box.txt`).

## Benchmark (box CPU; Railway's vCPU measured ~3-4x slower: 22 µs in prod vs ~6 µs here)
| Code | Rate | Main-thread µs/RFQ | Main busy | Loop lag max |
|---|---|---|---|---|
| Pre-hotfix (Oct 18 AM) | 3,500/s | 97 | 34% (≈100%+ on Railway → the collapse) | — |
| Current main, 1 thread | 3,500/s | 5.4-6.3 | 2% | 2.5 ms |
| Current main, 1 thread | 10,500/s (3x) | 5.4 | 6% | 2.2 ms |
| Current main, 1 thread | 20,000/s (~6x) | 5.4 | 11% | 2.5 ms |
| Pool, 3 threads | 3,500 / 10,500 / 20,000 | 3.4 / 3.3 / 2.5 | 1-5% | 2-8 ms |

Finding: after the Oct 18 hotfix, matching is no longer the bottleneck. The pool halves main-thread cost, but
postMessage overhead (~2.5-3 µs/frame) eats most of the gain and adds small lag spikes. The bigger remaining
main-thread costs are WebSocket frame decode/inflate + needle scan for ALL frames (incl. dropped ones).

## Recommendation
1. Keep single-thread matching (current main) for now: ~20x headroom on box, ~5-6x on Railway at peak.
2. If more is wanted, phase 2 = move the 8 shard sockets themselves into 2-4 worker threads (decode + drop + parse
   + match off-main; only matches/quote_*/relevant rfq_deleted cross over). Same single key, same process, still
   1 replica; main thread keeps sends/reservations. Bigger change, needs its own preview.
3. Railway: give combo-worker 4 vCPU / 4 GB (current usage is single-core bound; extra vCPUs only help once
   threads are on). Never raise replicas.
