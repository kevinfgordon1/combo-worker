# No-boost RFQ combo quoter (PAPER / SHADOW ONLY)

Quotes incoming Kalshi (and, where possible, Polymarket) RFQ combos that are **all NFL moneyline, every leg in a different game** — with no sportsbook boost / saved lock. Today this is **shadow only**: it logs what it *would* quote. No orders, quotes, confirms or cancels are ever sent (tests assert the modules contain no send code).

## Files (all under `noboost/`; nothing in the repo root or `package.json` is touched, so combo-worker / mm-paper / odds-relay are NOT redeployed by this code)
| file | role |
|---|---|
| `quote.js` | pure pricing (formula below), config/env |
| `risk.js` | pure risk book: per-combo / per-game / per-selection / total caps, daily loss limit, inventory skew, quote pull |
| `book.js` | in-memory NFL price book. **Per-leg true/mid/lock prices are precomputed on every price (re)ingest**, so the per-RFQ decision is lookup + multiply + caps (no I/O, no sportsbook fetch). Stale (>15s) or missing leg price => RFQ skipped |
| `shadow.js` | classifier + timed `onRfq` / `sweep` (logs `[NOBOOST][PRIMARY|LOCKCF] WOULD_QUOTE / SKIP / PULL … ms=<decision ms> maxLegAgeMs=<age>`; American odds only) |
| `paper.js` | paper-run bookkeeping: runs PRIMARY + LOCKCF (guardrail ON counterfactual) on every RFQ, matches later taker prints, simulates fills/positions vs caps, settles |
| `store.js` | writes `noboost_paper_rfqs` / `noboost_paper_stats` in our own Supabase |
| `runner.js`, `start.js` | the paper service (`node noboost/start.js`), **GET-only toward Kalshi, no WebSocket** |
| `summary.js` | report: wins, simulated P&L vs mid, exposure, by leg count, decision-latency + staleness p50/p99 |
| `backtest.js` | `node noboost/backtest.js --data <dir> [--since-created ISO]` |
| `run-tests.js` | runs the five `*.test.js` files (`node noboost/run-tests.js`) |

## Flags (all default OFF / safe)
`NOBOOST_SHADOW=1` turns shadow logging on (default off). `NOBOOST_LIVE` is never honoured — if set, the module **refuses to start**.

| env | default | meaning |
|---|---|---|
| `NOBOOST_MARGIN` | `0.10` | margin `m` (fraction) |
| `NOBOOST_MARGIN_MODE` | `price` | `price` or `capital` (see formula) |
| `NOBOOST_FAIR_METHOD` | `inverse` | `inverse` (lock method) or `mid` (no-vig book mid) |
| `NOBOOST_GUARDRAIL` | `lock` | `lock` = never quote below the price lockable via the inverse bets; `off` |
| `NOBOOST_MIN_LEGS` / `NOBOOST_MAX_LEGS` | `2` / `10` | legs window |
| `NOBOOST_TICK` / `NOBOOST_SUBCENT` | `0.001` / off | quote tick (round UP) |
| `NOBOOST_SKEW` | `1` | inventory skew strength |
| `NOBOOST_REF_MAX_DEV` | `0` (off) | skip if fair disagrees with a Pinnacle reference by more than this |
| `NOBOOST_MAX_COMBO_LOSS` / `_GAME_LOSS` / `_SELECTION_LOSS` / `_TOTAL_LOSS` | 250 / 1000 / 750 / 5000 | caps on max loss, $ |
| `NOBOOST_DAILY_LOSS_LIMIT` | `0` (off) | halt when settled day P&L ≤ −limit |
| `NOBOOST_PULL_MIN_EDGE` / `NOBOOST_QUOTE_TTL_MS` | `0.03` / `20000` | fast pull thresholds |
| `NOBOOST_RFQ_POLL_MS` / `NOBOOST_MARKETS_POLL_MS` | `1500` / `5000` | runner polling |

## Formula (exact)
We **sell** the parlay: the taker buys YES at price `y` (per $1 payout), we collect `y` and owe $1 if every leg wins.

1. **Per-leg true probability** (the "inverse bet" used by Combo Locks / Unhedged, `unhedged-quote.ourTrueFromOpponents`): the best fee-included price available on the *opposite* side of that moneyline (Kalshi single game, Polymarket), sign-flipped: `p_leg = 1 − cost_opp` (fee-adjusted with the venue taker fee, NFL θ=0.07 Kalshi, 0.06 Poly).
2. **Combo fair** (legs independent, different games): `P = Π p_leg`.
3. **Target price**, margin `m` (default 0.10), inventory skew `m_eff = m·(1 + skew·util)`:
   * `price` mode: `y_target = P · (1 + m_eff)` — our expected return on a $1 payout is `m_eff` of the true price (EV per contract = `y − P = m_eff·P`).
   * `capital` mode: `y_target = (P + m_eff)/(1 + m_eff)` — our expected return on capital at risk (`1 − y`) is `m_eff`.
   (Kalshi NFL-only combos have a 0 maker fee; Poly 0; a non-zero maker rate would be added to `P` before the margin.)
4. **Lock guardrail**: `y_lock = Π (cheapest fee-included own-side ask of each leg)` — the price at which the parlay can be rebuilt (hedged) from the legs. `y = max(y_target, y_lock)` — we never quote cheaper than a hedge can lock (the hedge itself is optional).
5. Round **up** to the tick (`0.001`), reject if outside (tick, 0.99].
6. Reported as American odds (`fair`, `lock`, `quote`). Percent/implied-probability is never logged.

## Risk rules (paper book, `noboost-risk.js`)
Max loss of a fill = `contracts × (1 − y)` (venues fill the **full** RFQ size, so all-or-nothing). Caps: per-combo, per-game (Σ open combos touching a game), per-selection (Σ combos that need the same team to win), total; optional daily loss limit; inventory skew widens the margin as utilisation (max of game/selection/total) → 1; fast pull of any open paper quote when the new fair makes edge < `pullMinEdge`, price drops below the lock, quote is older than TTL, or becomes unpriceable.

## Backtest
See the PR description and `noboost/backtest-output*.txt` (raw output). Data is Kalshi-only 1-minute ask/bid candles + public taker prints on KXMVE combos Sep 24 – Oct 1 2026; Polymarket history is not available, so Poly is wired (BUY = first slug team, SELL = other) but not backtested.

## Paper service (Railway `noboost-paper`)
Env: `NOBOOST_SHADOW=1`, `NOBOOST_FAIR_METHOD=mid`, `NOBOOST_GUARDRAIL=off`, `NOBOOST_MARGIN=0.10` (+ the shared `KALSHI_KEY_ID`/`Kalshi_combo_key` for REST GETs and `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`). `NOBOOST_LIVE` must never be set (the service refuses to start). Start: `node noboost/start.js`.
Read results: `railway run -s noboost-paper -- node noboost/summary.js [--since ISO] [--json]`, or query `noboost_paper_rfqs` / `noboost_paper_stats` in Supabase (migration `migrations/20261001_noboost_paper.sql`).

## PROMO variant (third shadow quoter; `NOBOOST_PROMO=1`, default OFF)
Promo-Builder-style *trusted-book* pricing, run beside PRIMARY and LOCKCF on the same RFQs (shadow/paper only).
- **Fair** = product over legs of a per-leg *consensus*: each trusted sportsbook's two-way price is de-vigged, exchange prices
  (Kalshi live book, Polymarket, Novig, ProphetX) join the blend, weights favor Pinnacle (3) / exchanges (1.5–2) / mainstream books (1);
  outliers (>0.06 from the median), incoherent two-ways and stale quotes are dropped; needs >=3 components incl. >=1 sportsbook, else the combo is *not priced*.
  Fliff and Courtside are excluded; Betstamp is not used. Also logged: `promoBest` = the literal Promo "best opposing price" true probability (high estimate).
- **Margin** 10% over that fair in price mode, lock guardrail OFF (same as PRIMARY). Everything is American odds in logs/DB (`promoFair=`, `promoBest=`, `books=`).
- **No I/O on the RFQ path**: `odds-ingest.js` parses the `odds_cache` row in the *background* refresher (every 60s) into `book.setBooks`, which precomputes the per-leg consensus; the RFQ decision is lookup + multiply. Sportsbook data older than 12 min makes PROMO refuse to price.
- Not available from our feeds (never appear): Bet105, BetCris, Prime, BookMaker, Circa, bet365. The ask-ladder VWAP blend (`blendAskLadderToPayout`) is ported but needs a depth refresher; `odds_cache` only has top-of-book size.
- Migration: `migrations/20261001_noboost_paper_promo.sql`. Report: `node noboost/summary.js` prints a side-by-side table across the variants.

## Optional separate-key WebSocket intake (NOT started)
`ws-intake.js` can receive `rfq_created` over Kalshi's communications WS to cut detect lag (polling: median ~1–2.5s) to ~ms. Kalshi allows one such WS per key,
so it **requires a new, separate Kalshi key** (`NOBOOST_KALSHI_KEY_ID` / `NOBOOST_KALSHI_PRIVATE_KEY`) and `NOBOOST_WS=1`; it refuses to run on combo-worker's key. Not wired into `runner.js`.
