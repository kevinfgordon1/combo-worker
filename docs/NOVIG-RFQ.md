# Novig RFQ maker (Combo Locks)

Shadow first. This process does not quote until `NOVIG_DRY_RUN=0` and `NOVIG_RFQ_LIVE=1`.

## What it does

Novig sends parlay RFQs on one signed websocket, `GET /rfq/v3/ws`. We subscribe to `rfq`, `quotes`, and `executions`. A quote is `{rfqId, price, maxWager, clientId}`. `price` is the parlay's win probability. The lowest price wins. There is no update and no cancel. The auction is 3 seconds. On `quote_accepted` we have 1 second to confirm.

We quote only when the RFQ's outcome ids are exactly one active Combo Lock. The price is the lock's `fill_american` turned into a win probability and rounded **up** to the next 0.001, never down, and kept inside 0.001–0.999 (maker fee is $0). RFQ accepts every thousandth in that range. It does not use the order book's 0.005 steps. `maxWager` is the user stake, capped by remaining payout, the subaccount balance, and the hard collateral caps. Before the quote is sent we insert a `combo_venue_holds` row (`venue = novig`) for the full payout (`maxWager / price`), which is the unit Kalshi and Polymarket already sum. Confirm does not re-check the cap. `COMBO_CAP_AT_CONFIRM` does not apply.

A hard fault (game already started, socket or catalog older than a few seconds, hold missing, kill switch, lock pause) rejects that last look and stops new quotes until the process is restarted. The trailing confirm rate pausing below 99.5% does the same. Novig's own bar is 99% over 24 hours, with a 5-minute lockout.

## Shadow

`NOVIG_SHADOW=1` (the default) writes `combo_novig_shadow` for RFQs that matched a lock: the price, the American odds of that price, the stake we would have offered, and later `would_win` from the executions channel (our price lower than the price that traded). Unknown and ambiguous RFQs are ignored.

```bash
node scripts/novig-shadow-summary.js
```

A `trading::read` key on the maker subaccount is enough to open the socket and read executions. It cannot quote.

## Secrets (names only)

Set on `kaygo-novig-worker` with `fly secrets`. Do not put Kalshi or Polymarket keys on this app.

| Name | Use |
| --- | --- |
| `NOVIG_KEY_ID` | Maker subaccount key id |
| `NOVIG_PRIVATE_KEY` | PKCS#8 PEM. Shadow: `trading::read`. Live: `trading` |
| `SUPABASE_URL` | Locks, holds, shadow, fills |
| `SUPABASE_SERVICE_KEY` | Service role |
| `TELEGRAM_BOT_TOKEN` | Optional. Same alert path as the other workers |
| `TELEGRAM_ALERT_CHAT_ID` | Optional |

`NOVIG_API_BASE` defaults to `https://api.novig.com`. Paper is `https://api.paper.novig.com`.

## Rollout

1. Apply `migrations/20261113_novig_rfq.sql` in the Supabase SQL editor. The worker does not run it.
2. Deploy is a separate step. The toml is `fly/novig-worker.toml` (`kaygo-novig-worker`, one machine, `iad`). It is not created or deployed here. Shadow flags are already in `[env]`.
3. Put the read key on the app and watch `node scripts/novig-shadow-summary.js`.
4. After that looks right: fund the maker subaccount, swap in the `trading` key, then set `NOVIG_DRY_RUN=0` and `NOVIG_RFQ_LIVE=1`. Raise `NOVIG_MAX_WAGER_USD` (default $25), `NOVIG_MAX_COLLATERAL_PER_QUOTE` ($100), `NOVIG_MAX_COLLATERAL_PER_LOCK` ($250), and `NOVIG_MAX_COLLATERAL_TOTAL` ($500) only as far as you mean to risk.

## aibetbuilder (not edited here)

`combo_submissions.venue` can now be `novig`. The site chips know Kalshi and Polymarket, and unlabeled rows show as Kalshi. Add a Novig label wherever that column is rendered, including the filled card. Fills are real rows in `combo_fills` (`raw.venue = novig`, `raw.source = novig-rfq`), not Kalshi quote stubs.

## Voided leg

A voided leg settles at its fair value, not as a push. The parlay pays the user `pot × scalar`, and the scalar is the product of the leg values (a loss is 0, a void is that fair value, a win is 1), rounded to three decimals and never below 0.001. One void with the other legs winning pays the user part of the pot. A loss still pays us the whole pot. The quote does not add extra collateral for that partial payout.

## Open questions for Novig

- Is there a quote rate limit on the RFQ socket beyond the 256-frame outbound queue?
- What is `minSample` on `GET /rfq/v3/maker` during beta? We pause ourselves below 99.5% from the first last look.
- Does Paper publish RFQ traffic we can shadow before production?
- Does a `trading::read` key on a registered maker receive `rfq` and `executions`?
- Does production's location check accept a machine in `iad` (Ashburn, Virginia)? Restricted states are Arizona, Michigan, and Nevada. A data-center IP is allowed. The companion device check is separate.
