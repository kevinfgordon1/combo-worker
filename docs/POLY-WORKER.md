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

## Polymarket sniper: live mode (preview, Kevin Oct 29)

Runs inside poly-worker (`kaygo-poly-worker`), the only app with the Polymarket keys. Code: `poly-sniper/live.js`.

- **Two locks.** `POLY_SNIPER_DRY_RUN=1` (secret, current value) is the hard dry run: the sniper never gets a Polymarket client. `POLY_SNIPER_DRY_RUN=0` makes live possible, but nothing is posted until `public.poly_sniper_control.live = true` (default false). The switch is polled every 5s, so it flips without a restart. Turning it off deletes every open sniper quote and declines any accept still in last look. If the switch can't be read for 30s, it counts as off.
- **Caps = Kalshi sniper caps:** $500 risk / $100,000 payout per quote, $1,500 per game, $1,000 per leg (Kevin Oct 30: was $400 / $750), $10,000 open, $5,000 open on parlays settling >48h out, $10,000 new filled risk per ET day, $10,000 realized daily loss stop (auto-off until midnight ET), soon-cap (settles within 24h: total cap = cash above the floor, never below $10,000), legs at most 7 days out. Min edges (`POLY_SNIPER_MIN_ROI_*`, Kevin Oct 30): nothing below 5% — NFL ML 5% (was 3%), other NFL 5% (was 4%), NCAAF 5%, NBA 6%, player-TD 6%.
- **Only real exposure counts.** Resting quotes count $0. An accept being confirmed, or a confirmed quote waiting on its fill, counts at the accepted size. After the fill, the real filled worst case counts.
- **Last look.** On `quoteAccepted`, inside `confirmationDeadline` (minus 300 ms): fresh fair price and min edge (engine re-run at the accepted size), then all caps, the cash floor and kickoff. One confirm decision runs at a time. Combo Locks confirms go first: the sniper waits up to 150 ms while one is in flight. Anything that fails is declined (quote deleted).
- **Pauses:** declines above 10% of sniper accepts in the last hour, or account-wide (sniper + Combo Locks) when the sniper also declined. Polymarket pauses makers over 15%. Also pauses on a Polymarket RFQ WS stall, until it recovers.
- **Stale cancels** (every 2s): stale prices, feed stall, fair moved past our edge, within 30 min of kickoff, 60s TTL, and RFQ closed.
- **Startup cleanup:** rows left in `quoted`/`accepted` by a previous process are deleted on the venue and never confirmed. Filled and confirmed rows reload into the cap ledger. SIGTERM deletes all open sniper quotes before the client closes.
- **Fills** are booked from the quote's own order (WS `quoteExecuted` / `orderExecution`), with the #308 REST backstop (`GetQuotes EXECUTED SELF` + `GET /v1/order` through `resolveQuoteFill`), into `poly_sniper_ledger`. Combo Locks' reconcile and accept/confirm code skip every sniper quote, order and fill.
- **Rate limits:** sniper posts ≤20/s and cancels ≤20/s on their own buckets. Combo Locks is untouched.
- **No Combo Locks skip check** (Kevin's call). On the same RFQ, Polymarket keeps only our latest quote (a new CreateQuote replaces the old one), so whichever posts second wins. Oct 25–29 overlap: 1 of 799 sniper would-quotes.

Turn on: apply `migrations/20261029_poly_sniper_live.sql` → merge/deploy → `fly secrets set POLY_SNIPER_DRY_RUN=0 -a kaygo-poly-worker` → `update public.poly_sniper_control set live = true, updated_at = now(), updated_by = 'kevin' where id = 1;`
Turn off: `update public.poly_sniper_control set live = false ... where id = 1;` (no restart). Hard off: `POLY_SNIPER_DRY_RUN=1`.
