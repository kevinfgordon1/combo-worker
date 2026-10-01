# No-boost RFQ combo quoter (PAPER / SHADOW ONLY)

Quotes incoming Kalshi (and, where possible, Polymarket) RFQ combos that are **all NFL moneyline, every leg in a different game** — with no sportsbook boost / saved lock. Today this is **shadow only**: it logs what it *would* quote. No orders, quotes, confirms or cancels are ever sent (tests assert the modules contain no send code).

## Files
| file | role |
|---|---|
| `noboost-quote.js` | pure pricing (formula below), config/env |
| `noboost-risk.js` | pure risk book: per-combo / per-game / per-selection / total caps, daily loss limit, inventory skew, quote pull |
| `noboost-book.js` | in-memory NFL price book (Kalshi `KXNFLGAME` asks/bids, Poly ML), kickoff = `occurrence_datetime − 3h` |
| `noboost-shadow.js` | classifier + `onRfq` / `sweep` (logs `[NOBOOST] WOULD_QUOTE / SKIP / PULL`, American odds only) |
| `noboost-runner.js`, `start-noboost.js` | standalone paper job (`npm run start:noboost-paper`), **GET-only**, no WebSocket |
| `scripts/noboost-backtest.js` | `npm run backtest:noboost -- --data <dir> [--since-created ISO]` |

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
See the PR description and `docs/noboost-backtest-output*.txt` (raw output). Data is Kalshi-only 1-minute ask/bid candles + public taker prints on KXMVE combos Sep 24 – Oct 1 2026; Polymarket history is not available, so Poly is wired (BUY = first slug team, SELL = other) but not backtested.
