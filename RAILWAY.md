# Railway: Combo Locks + Unhedged (two services)

Combo Locks and Unhedged RFQ shadow are **separate processes**. Quote POSTs stay on the Combo Locks worker. Markets GETs, shadow tape, fill tracking, and Unhedged firehose side-work run on the Unhedged job so they cannot delay a Combo Lock auction.

Do not re-enable quote-watcher. Do not set `UNHEDGED_RFQ_LIVE=true` — Unhedged stays paper/shadow only.

## Current production

| | |
|---|---|
| Project | `combo-worker` |
| Environment | `production` (`astonishing-clarity`) |
| Existing service | `combo-worker` — Combo Locks (Kalshi + Polymarket) + `fills-reader` |

This PR does **not** deploy. After review, add the second service and flip the locks-only flag as below.

## Architecture

```
combo-worker          →  npm start / node start-live.js
                         live-runner.js   (Kalshi + Poly Combo Locks quotes)
                         fills-reader.js  (combo_fills for the Filled tab)

combo-unhedged        →  npm run start:unhedged / node start-unhedged.js
                         unhedged-runner.js  (shadow tape → unhedged_rfqs)
```

Both processes read `combo_parlays` (Unhedged only to classify lock-match vs lock-miss). Combo Locks Miss tape / parlays (`combo_submissions`) stay on `live-runner`. The Unhedged dashboard keeps reading `unhedged_rfqs`.

Unhedged scope is unchanged: MLB and NFL full-game moneylines only (no NCAAF); no Polymarket maker rebates in unhedged quotes; same-slate different games OK; no same-game / SGP correlation fills.

## Env flags

| Variable | Combo Locks (`combo-worker`) | Unhedged (`combo-unhedged`) |
|---|---|---|
| `WORKER_ROLE` | `locks` (recommended once the second service exists) | omit, or `unhedged` |
| `UNHEDGED_IN_PROCESS` | `0` once the second service is up | ignored (this process always runs Unhedged) |
| `UNHEDGED_RFQ_SHADOW` | unused when locks-only | default on (set `0` to idle the tape) |
| `UNHEDGED_RFQ_LIVE` | **off** | **off** — posting is not wired |
| `POLYMARKET_RFQ_LIVE` | your existing Combo Locks live flag | ignored for posting (`quoteLocks=false`) |

`UNHEDGED_IN_PROCESS` defaults **on** so you can ship this code to the existing `combo-worker` **before** the second service exists. The Unhedged dashboard keeps updating from the Combo Locks process until you flip the flag.

`WORKER_ROLE=locks` also forces locks-only (wins over `UNHEDGED_IN_PROCESS=1`). `WORKER_ROLE=unhedged` on `start-live.js` exits — use `start-unhedged.js`.

## Shared secrets

Copy these from `combo-worker` onto `combo-unhedged` (same Supabase project, same venue keys):

- `KALSHI_KEY_ID`
- `Kalshi_combo_key` (or `KALSHI_PRIVATE_KEY`)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `POLYMARKET_KEY_ID`
- `POLYMARKET_SECRET_KEY`

Telegram / Combo Locks-only vars (`TELEGRAM_*`, `RFQ_REPEAT_COOLDOWN_MS`, `POLYMARKET_RFQ_LIVE`) are not required on the Unhedged service.

Two communications WebSockets (one per service) is expected. Do **not** run Unhedged in-process and as the second job at the same time — flip `UNHEDGED_IN_PROCESS=0` on Combo Locks when `combo-unhedged` is live.

## Add the second Railway service (Kevin)

1. In project `combo-worker` / environment `production`, **New service** from the same GitHub repo (`kevinfgordon1/combo-worker`).
2. Name it `combo-unhedged` (or similar). Same branch you deploy Combo Locks from.
3. Start command: `node start-unhedged.js` (or `npm run start:unhedged`).
4. Copy the shared secrets above. Set `UNHEDGED_RFQ_LIVE` unset/false. Leave `UNHEDGED_RFQ_SHADOW` default-on.
5. On **`combo-worker`** (Combo Locks):
   - Start command stays `npm start` / `node start-live.js` (must **not** start `unhedged-runner`).
   - Set `UNHEDGED_IN_PROCESS=0` and/or `WORKER_ROLE=locks`.
   - Redeploy Combo Locks so the in-process tape stops.
6. Confirm `combo-unhedged` logs `[UNHEDGED] starting — paper/shadow only` and that it never logs `[LIVE] QUOTED` / Poly `QUOTED`.

## Rollback

1. On `combo-worker`, unset `UNHEDGED_IN_PROCESS` / `WORKER_ROLE` (back to default in-process Unhedged) and redeploy.
2. Stop or remove `combo-unhedged`.
3. Unhedged dashboard reads the same `unhedged_rfqs` table either way.

To roll back the code, revert this PR on `combo-worker` and stop the second service.

## Post-deploy checks

- Combo Locks: Kalshi + Polymarket still quote; `[LAT]` / `QUOTED` lines continue; Miss tape / parlays unchanged; oversized / cap / soft-fail lock retention unchanged.
- Unhedged page: new `seen` / `started` / `filled` rows appear from the **new** job (`mode=UNHEDGED` in `combo_worker_stats`).
- Combo Locks Railway CPU/event loop should no longer paginate `/markets` or tick the Unhedged fill tracker.
- `UNHEDGED_RFQ_LIVE` remains off. No live Unhedged POSTs.
