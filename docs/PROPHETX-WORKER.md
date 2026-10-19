# prophetx-worker (ProphetX SANDBOX parlay RFQ quoter)

Separate Railway service (`npm run start:prophetx`, us-east4, 1 replica). It never
runs inside combo-worker and loads no Kalshi / Polymarket / Novig trading keys.

## Guard (`px/guard.js`)
Refuses to start unless `PX_SANDBOX=1`, both ProphetX bases are `https://*.sandbox.prophetx.dev`,
and no Kalshi / Polymarket / Novig / ProphetX-production key names are present in the env.
Every callback URL from ProphetX is checked to be a sandbox host before we POST to it.

## Env
| Name | Purpose |
| --- | --- |
| `PX_SANDBOX=1` | required |
| `PROPHETX_SANDBOX_API_KEY`, `PROPHETX_SANDBOX_SECRET_KEY` | sandbox access/secret key pair |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | logging (optional; without them rows are logged to stdout) |
| `PX_MAX_RISK` (default 10) | `max_risk` per offer, $ |
| `PX_OFFER_SIGN` (`participant` default / `mm`) | sign convention for the offer `price` |

## Flow
1. One `/auth/login`, then `/auth/refresh` before expiry (login again only if refresh fails).
2. Catalog every 10 min: full-game moneyline strikes for NFL (31), MLB (109), College Football (27653)
   that have not started; register them with `POST /supported-strikes`, drop the rest.
3. Parlay socket (Pusher protocol, `ws`): `v2.price.ask.new` → screen → price → POST offer to `callback_url`.
4. `price.confirm.new` → re-price (≤15s old) → accept if our offer is still at or worse than fresh fair,
   else reject → `price_probability` legs scaled so their product = implied(−confirmed_price) (docs "mirror").
5. `order.finalized` / `order.settled` patch the row.

## Pricing (unchanged inverse bet method)
Leg fair = sign-flip of the opponent's best fee-included price walked to **$500 profit** across
Kalshi / Polymarket / Novig public books (`px/vendor/book-depth.js` + `blendAskLadder.cjs`, vendored
verbatim from aibetbuilder 768ea81; `ourTrueFromOpponents` from `unhedged-quote.js`). A venue whose
ladder cannot fund $500 is ignored. Leg prices older than **15 s** are never quoted. Parlay fair =
product of legs; offer = fair × `DEFAULT_QUOTE_MULT` (1.05), participant American floored in our favor.
ProphetX production depth is NOT a source (needs a production key this process must not hold).

## No quote (silent decline)
<2 or >8 legs, any strike we did not register, two legs from one game (correlated / SGP), game started,
any leg unpriced / stale / thin (<$500), price timeout (5 s). Declines are counters only.

## Data
`prophetx_sandbox_quotes` (one row per quoted parlay), `prophetx_sandbox_stats` (daily counters),
view `prophetx_sandbox_clean` (clean = accepted + finalized + no probability error).
