# poly-worker: Polymarket Combo Locks quoting as its own Railway service (PREVIEW)

Goal: Polymarket streaming/429s/REST polling can never stall Kalshi quoting again.

## Processes after the split
| Service | Start | Owns |
|---|---|---|
| combo-worker (existing, 1 replica) | `npm start` with `COMBO_POLY_ENABLED=0` | Kalshi WS (8 shards), Kalshi quote/confirm, fills-reader, bucket manager, **single-leg hedges on both venues** (REST-only Polymarket client), desk-fill alerts, desk-protect |
| poly-worker (new, 1 replica) | `npm run start:poly` (`COMBO_ROLE=poly`) | Polymarket private RFQ stream, Polymarket lock quote/confirm, Polymarket Miss tape. Never opens a Kalshi WS, never touches Kalshi orders. No Kalshi keys needed. |

## Shared lock state / no double fills
- Lock caps are enforced at **confirm** (`COMBO_CAP_AT_CONFIRM=1`, required; process refuses to start otherwise).
- Every confirm in either process calls `combo_venue_claim` (migration `20261018_combo_venue_holds.sql`): per-lock `pg_advisory_xact_lock`, inserts this venue's hold and returns the other venue's live holds; `confirmAgainstCap` re-checks the cap including them. Two simultaneous accepts on one lock serialize, only one can exceed the cap.
- Claim error = fail closed (no confirm). `COMBO_COORD_FAIL_OPEN=1` is an emergency escape only.
- Releases/reductions mirror to the table (batched 500 ms). Other venue's holds polled every 1 s into memory for quote-time sizing. Holds have a 30 min hard TTL; each process clears its own rows on boot.
- Single-leg hedges (rest on Kalshi and Polymarket, cancel/shrink on fill) stay entirely in combo-worker — one owner, logic unchanged. Only the Polymarket *RFQ stream* moves.
- Unchanged: pricing, inverse bet method, $500-depth / 15% / 15 s rules, 429 breaker, one Kalshi WS per key.

## Disabling Polymarket in combo-worker
`COMBO_POLY_ENABLED=0` skips `startPolymarketRfqLoop`. Unset/1 = today's in-process behaviour (instant rollback).

## Env (names only)
combo-worker adds: `COMBO_POLY_ENABLED=0`, keeps `COMBO_CAP_AT_CONFIRM=1`, optional `COMBO_VENUE_COORD`, `COMBO_COORD_FAIL_OPEN`.
poly-worker: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `POLYMARKET_KEY_ID`, `POLYMARKET_SECRET_KEY`, `POLYMARKET_RFQ_LIVE`, `COMBO_CAP_AT_CONFIRM=1`, `POLY_DRY_RUN`, optional `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`, plus the same user-scope vars combo-worker uses. **No** `KALSHI_KEY_ID` / Kalshi PEM.

## Dry run
`POLY_DRY_RUN=1`: streams and evaluates RFQs, logs `[POLY-DRY] would …`, never POSTs quotes/confirms, never writes Miss-tape or venue-hold rows.

## Rollout
1. Apply migration `20261018_combo_venue_holds.sql` (additive table + function).
2. Create Railway service `poly-worker` from this repo, start `npm run start:poly`, replicas 1, `POLY_DRY_RUN=1`, `POLYMARKET_RFQ_LIVE=0`. Watch 1 game window: would-quote counts vs combo-worker paper expectations, 0 Kalshi activity.
3. Deploy combo-worker with `COMBO_POLY_ENABLED=0` (Polymarket is already off live, so no behaviour change for Kalshi). Confirm loop lag/[SENDTIME] unchanged.
4. Kevin approves → poly-worker `POLY_DRY_RUN=0`, `POLYMARKET_RFQ_LIVE=1`, tiny caps first.

## Rollback
- poly-worker misbehaves: set `POLYMARKET_RFQ_LIVE=0` (or stop the service). Kalshi unaffected.
- Want old setup: stop poly-worker, unset `COMBO_POLY_ENABLED` on combo-worker. Holds table is ignored when not split.
