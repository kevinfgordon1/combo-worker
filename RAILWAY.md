# Railway: services from this repo

Combo Locks and Unhedged RFQs are **separate processes**. They share the same GitHub repo, Supabase project, and Kalshi / Polymarket credentials. They must **not** share a Node event loop or the Combo Locks Kalshi quote HTTP pool.

Do **not** Railway-deploy from this PR unless asked. Create / wire the second service in the Railway dashboard (or CLI) when you are ready.

## Architecture

| Service | Entrypoint | What it owns | What it must not do |
|---|---|---|---|
| **Combo Locks** (existing worker) | `npm start` → `start-live.js` (`live-runner.js` + `fills-reader.js`) | Kalshi WS + Poly Retail RFQ **locks**: exact-lock quoting, confirm, fills, Miss tape (`combo_submissions`), reserves/caps, skip-tape, `combo_fills` | Unhedged `/markets` refresh, unhedged fill ticks, shadow-miss persist to `unhedged_rfqs` |
| **Unhedged RFQs** (new worker) | `npm run start:unhedged` → `start-unhedged.js` (`unhedged-runner.js`) | Own Kalshi WS + REST, own Poly listen, own MLB/NFL price cache, paper tape + fill tracking on `unhedged_rfqs` | Combo Lock quote POST / confirm. `UNHEDGED_RFQ_LIVE` stays off (paper/shadow only) |
| **Odds relay** (board fanout) | `npm run start:odds-relay` → `start-odds-relay.js` | Polymarket US markets websocket, international CLOB fallback, Kalshi public REST (and a market-data websocket only with its own key). SSE for the New Odds Board | Combo Locks, Unhedged, `WORKER_MODE`, Kalshi `communications`. Do not copy Combo Locks `KALSHI_KEY_ID` |

`WORKER_MODE` (default **`combo`**):

- `combo` — Combo Locks only (Railway service 1)
- `unhedged` — Unhedged job only (Railway service 2; `start-unhedged.js` sets this)
- `all` — old one-process wiring (`npm run start:all`). Local / rollback only. Do not use in production.

Quote-watcher stays parked on both jobs (`sleep infinity`, or `QUOTE_WATCHER_WS=0` / `KALSHI_WS_OWNER=combo`). **Never** run `node quote-watcher.js` against the Combo Locks `KALSHI_KEY_ID` — Kalshi keeps one communications subscription per key.

## Kalshi communications WS — one subscriber per API key

Kalshi keeps **one full `communications` subscription per `KALSHI_KEY_ID`**. A second process on that key (`quote-watcher`, a second Combo Locks replica, Unhedged using the copied key) receives `unsubscribed` after ~30–40s. The TCP socket stays up and pongs, so `kalshiWsAgeMs` looks healthy while Combo Lock quoting is dead (`rfq_created` stops).

**Production owner:** Combo Locks (`npm start` / `start-live.js`) — replica count **1**.

Combo Locks itself opens **one socket per `shard_key`** on that same key (`KALSHI_WS_SHARD_FACTOR`, default 8) so the RFQ firehose is split across Kalshi subscription buffers. That is one subscriber, not a second process. Do not point another process at this key. If those sockets get `unsubscribed` or `already subscribed`, the worker collapses to a single unsharded socket and keeps running. Set `KALSHI_WS_SHARD_FACTOR=1` to skip sharding. `KALSHI_WS_FAST_DROP=0` parses every `rfq_created` again (quote and fill events are never dropped either way).

| Process | What to do |
|---|---|
| **quote-watcher** | Park on Railway (`sleep infinity`), or start with `QUOTE_WATCHER_WS=0` / `KALSHI_WS_OWNER=combo` (REST-only; no WS). |
| **Combo Locks replicas** | Never scale above 1. Several shard sockets inside that one process are expected. |
| **Unhedged** | Needs its **own** Kalshi API key if it opens `createKalshiWs`. Copying Combo Locks `KALSHI_KEY_ID` will unsubscribe the quoter. |

## Deploy two services (same repo)

1. Keep the existing Combo Locks service.
   - **Start command:** `npm start` (or `node start-live.js`)
   - **WORKER_MODE:** unset or `combo`
   - Replica count: **1** (two Combo Locks processes would double-quote)

2. Add a second Railway service from the **same repo / same branch**.
   - **Name:** e.g. `unhedged-rfq`
   - **Start command:** `npm run start:unhedged`
   - **WORKER_MODE:** unset (`start-unhedged.js` sets `unhedged`) or `unhedged`
   - **UNHEDGED_RFQ_LIVE:** unset / `false` / `off`
   - **UNHEDGED_RFQ_SHADOW:** unset or `true` (paper tape on)
   - Replica count: **1**

3. Copy the shared env vars onto the Unhedged service, except Kalshi keys:

   - **Do not copy Combo Locks `KALSHI_KEY_ID` / `Kalshi_combo_key` if Unhedged opens its own communications WS.** Use a distinct Kalshi API key. Same key → Combo Locks gets `unsubscribed` and quoting goes silent.
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `POLYMARKET_KEY_ID`, `POLYMARKET_SECRET_KEY` (needed for Poly paper tape / fill lookup)
   - Optional: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID` (Combo Locks alerts; Unhedged is console-only)

4. Combo Locks accounting tables stay shared and unchanged: `combo_parlays`, `combo_settings`, `combo_submissions`, `combo_fills`, `combo_worker_stats`. Unhedged reads `combo_parlays` (soft-fail retain) so lock-matched RFQs are skipped, and writes `unhedged_rfqs` only.

## Unhedged persist / env re-check

`unhedged-rfq` writes `public.unhedged_rfqs` through PostgREST (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`). `TypeError: fetch failed` is a **transport** error (undici connect / DNS / Cloudflare 520/522), not a schema or RLS error. A copied env from Combo Locks is usually correct; still confirm on the **unhedged-rfq** service (not Combo Locks):

- `SUPABASE_URL` is `https://<project-ref>.supabase.co` (not a `postgresql://` URI, not wrapped in quotes)
- `SUPABASE_SERVICE_KEY` is the **service_role** JWT (same value as Combo Locks). Anon/publishable keys fail RLS, they do not produce `fetch failed`.
- `UNHEDGED_RFQ_LIVE` unset / `false` / `off` — paper/shadow only
- `UNHEDGED_RFQ_SHADOW` unset or `true`
- `WORKER_MODE` unset or `unhedged`
- Start command: `npm run start:unhedged`

Optional: `SUPABASE_FETCH_IPV4=1` forces IPv4 if Railway DNS/IPv6 to `*.supabase.co` is broken.

The Unhedged job uses a dedicated undici Agent + bounded retries + rate-limited error logs. Combo Locks quoting is unchanged.

## Adverse Protect (Kevin's Live Trading Desk)

Combo Locks can poll aibetbuilder so an **armed** Polymarket US desk rest is not left as a stale gift. This worker does not call Polymarket, does not quote RFQs, and does not read combo user tables. Cancel / re-rest math stays in aibetbuilder.

The poller starts only on the Combo Locks service (`npm start` / `start-live.js`), and only when both env vars below are set. The Unhedged job does not start it. With the URL unset it logs one line and makes no request.

| Env | Default | Meaning |
|---|---|---|
| `DESK_PROTECT_SWEEP_URL` | unset | HTTPS URL, `POST /api/desk-protect-sweep` on aibetbuilder. Unset → poller is not started. |
| `DESK_PROTECT_SWEEP_SECRET` | unset | Shared secret, request header `X-Desk-Protect-Secret`. At least 16 characters, one line. Not a Supabase user JWT. Do not prefix with `VITE_`. Do not put it in the URL. |
| `DESK_PROTECT_POLL_MS` | `1500` | Clamped to 1000–10000. |
| `DESK_PROTECT_THROUGH_CENTS` | `3` | X. Cents through mid that count as picked off. Sent as `defaults.throughCents`. |
| `DESK_PROTECT_REST_OFFSET_CENTS` | `1` | Y. Re-rest a buy at mid − Y and a sell at mid + Y. `0` re-rests at mid. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID` | optional | One ping per adverse event. If unset, the same text is logged once. |

Point Combo Locks at the sweep after aibetbuilder is serving it (same secret on that server only):

```
DESK_PROTECT_SWEEP_URL=https://<your-aibetbuilder-host>/api/desk-protect-sweep
DESK_PROTECT_SWEEP_SECRET=<long random>
```

Live Trading Desk PR #210 places and cancels for the owner. It does not ship this sweep. Until that route exists, leave `DESK_PROTECT_SWEEP_URL` unset. A URL that 404s only logs on this worker; it still does not cancel or replace orders.

### Sweep contract

`POST` JSON:

```json
{
  "op": "sweep",
  "mode": "adverse-only",
  "defaults": { "throughCents": 3, "restOffsetCents": 1 },
  "ackedIds": []
}
```

Wrong or missing `X-Desk-Protect-Secret` → `401` and no orders touched. This is not the Desk route that takes a user JWT. Owner / Desk only.

Act only on rests that have **Protect armed** on that order. Unarmed orders stay put. Use the order’s own X and Y when it was armed; otherwise use `defaults`.

**Adverse only.** If the resting outcome price is at least X¢ through the current mid, cancel it and re-rest better (buy lower, sell higher). If the market runs away from the rest, do nothing. Never move a buy up or a sell down to follow the market.

Idempotent. Repeating the sweep must not cancel the replacement unless that new rest is itself ≥ X¢ through mid. `ackedIds` were already announced — do not return them. Do not return chase or follow events. Each event needs a stable `id`.

```json
{
  "ok": true,
  "events": [
    {
      "id": "prot_…",
      "kind": "adverse-reprice",
      "adverse": true,
      "orderId": "canceled",
      "newOrderId": "replacement",
      "marketSlug": "aec-…",
      "label": "Titans",
      "action": "buy",
      "outcome": "short",
      "fromCents": 43,
      "toCents": 40,
      "midCents": 46,
      "throughCents": 6,
      "restOffsetCents": 1
    }
  ]
}
```

This worker pings Telegram once per adverse id (`kind` `adverse-reprice`, or `adverse: true` with no chase kind). A restart can repeat a ping only if the sweep returns that same id again. It will not place a second order. Keep Combo Locks at replica count **1** so two processes do not sweep the same rests.

## Odds relay (third service)

The New Odds Board reads this process directly from the browser (`VITE_ODDS_RELAY_URL` on aibetbuilder). Vercel functions cannot hold the venue sockets for a whole game. This service does.

Do **not** attach it to Combo Locks or Unhedged. Do **not** Railway-deploy it from a PR unless asked. Add a third service when you are ready.

- **Name:** e.g. `odds-relay`
- **Start command:** `npm run start:odds-relay`
- **Replica count:** 1
- **WORKER_MODE:** leave unset. `start-odds-relay.js` does not start the combo event loop.
- **PORT:** Railway sets this. Local default is `8787`.
- Copy `POLYMARKET_KEY_ID` and `POLYMARKET_SECRET_KEY` (same Retail Ed25519 pair as Combo Locks). That key signs `GET /v1/ws/markets`. Combo Locks uses it for REST, not this markets socket.
- **Do not copy** Combo Locks `KALSHI_KEY_ID` / `Kalshi_combo_key`. A second socket on that key unsubscribes communications and Combo Lock quoting dies.
- Kalshi ticks: set `ODDS_RELAY_KALSHI_KEY_ID` and `ODDS_RELAY_KALSHI_KEY` (or `ODDS_RELAY_KALSHI_PRIVATE_KEY`) only when that key is a **different** Kalshi API key. The relay subscribes to `ticker` and `orderbook_delta` only. Without it, the relay polls public REST and still applies the ESPN kickoff overlay.
- No Supabase. No Telegram.
- Public URL (no trailing slash) becomes `VITE_ODDS_RELAY_URL` on the Vercel project. The browser connects to `GET /stream?league=NFL&venue=polymarket` and `venue=kalshi`. CORS is `*`.

`GET /health` returns `{ ok, status, counts }` and no key material. `status.us` is `no-key` until the Polymarket pair is set; international CLOB is the book until the US socket is up. `status.kalshi` is `rest` until the dedicated key connects.

## Local

```bash
npm start                 # Combo Locks + fills-reader (WORKER_MODE=combo)
npm run start:unhedged    # Unhedged paper tape only
npm run start:all         # both in one process (escape hatch)
npm run start:odds-relay  # board relay only (port 8787 or $PORT)
npm test
```

## Kalshi sub-cent quoting and burst-latency knobs

- `KALSHI_SUBCENT=1` — quote Kalshi at the exact lock target on the 0.001 grid (MVE `price_level_structure` `center_deci_edge_centi_cent`) instead of flooring to the cent. Read at boot. Latches off (penny quoting) after 3 consecutive off-grid rejections and sends a Telegram alert.
- `KALSHI_WS_DROP_DELETED` (default on, `0` disables) — drop `rfq_deleted` frames before JSON.parse unless we hold a reserve/quote on that rfq. Ignored when unhedged shares the process.
- `KALSHI_STALE_RFQ_MS` (default `15000`, `0` disables) — skip, rather than quote, an RFQ that reaches the handler older than this.
- Dead-channel WS reconnects (`channel_error`, `unsubscribed`) wait ~100-200ms (jittered), doubling per repeat drop of one socket inside 60s, capped at 8s.
- Quote HTTP uses an undici `Pool` of `QUOTE_CONNECTIONS` sockets (was a single-socket `Client`); warm pings fan out to all of them.
- Poly REST crawl pauses (bounded) while a Kalshi quote POST/confirm is in flight.
- Heartbeat: `[LATENCY]` log line + `combo_worker_stats.latency` jsonb (migration `20261002_combo_worker_stats_latency.sql`): `quote_ms`, `intake_ms` (RFQ age at our handler), `posted_age_ms` histograms, `late_posts` (>1s), `rfq_closed`, `stale_skipped`, reconnects by reason, `resubscribe_gap_max_ms`, `loop_lag_ms`.

## Polymarket exact-target pricing and burst-latency knobs

- `POLY_EXACT_TARGET` (default on; `0`/`false`/`off`/`no` restores the old floor-to-tick price) — Polymarket `buyPrice` is the lowest 0.001 tick where `price + guaranteed maker rebate >= lock target` (`ceil(target)` when the rebate cannot be credited). Rebate = `theta*p*(1-p)` per contract (theta `POLY_MAKER_REBATE_THETA`, default `0.0125`), credited only on fills of at least `POLY_REBATE_MIN_CONTRACTS` (default `40`) and net of half a cent of per-fill rounding. The engine refuses a quote whose net is below target (`quote_below_target`) and computes hit/miss/worst at the price sent. Read per RFQ, so a flip needs no restart for new quotes after a redeploy of env.
- `POLY_STALE_RFQ_MS` (default `30000`, `0` disables) — WS-delivered RFQs older than this are skipped, not quoted (REST-crawled RFQs are exempt).
- `POLY_QUOTE_WARM_MS` (default `15000`) — warm all quote-pool sockets this often.
- Polymarket HTTP uses an undici `Pool` of 4 sockets for reads and a separate lazily-created `Pool` of 3 for quote POST/PUT/DELETE (was a single-socket `Client`); connect 2.5s, headers/body 8s on the quote pool.
- Active lock leg market metadata is prefetched every 5 min so the first line/prop RFQ in a burst pays no market GET.
- Heartbeat: `[POLY-LATENCY]` log line and `latency` inside the `combo_worker_stats.poly` jsonb (same histograms as Kalshi: `quote_ms`, `intake_ms`, `posted_age_ms`, `late_posts`, `rfq_closed`, `stale_skipped`). The `[POLY] QUOTED` line now carries `fill`, `eff`, `rebate_c`, `exact`, `ms`.

## Success checks after you deploy

- Combo Locks logs: `WORKER_MODE=combo` and `Unhedged /markets, fill ticks, and shadow miss are off`.
- Unhedged logs: `[UNHEDGED] starting — paper/shadow only` and `UNHEDGED_RFQ_LIVE=off`.
- Combo Locks still posts / confirms lock quotes. Unhedged never logs `QUOTED` / `CONFIRMED` for Combo Locks.
- `unhedged_rfqs` still receives in-scope unmatched MLB/NFL full-game moneyline paper rows when the Unhedged job is up.

## Odds relay: DraftKings / FanDuel feed (`DKFD_FEED`)

Off unless `DKFD_FEED=1` on the **odds-relay** service. Kevin approved this feed for the New Odds Board (Oct 7 2026).

- DraftKings: `sportsbook-nash.draftkings.com/api/sportscontent/dkusnj/v1/leagues/{id}` (NJ), one request per league per poll. Akamai answers 403 without normal browser headers (`Accept-Language`, `Origin`, `Referer`).
- FanDuel: `sbapi.nj.sportsbook.fanduel.com/api/content-managed-page` (public `_ak`) is the catalog only (CloudFront `max-age=30, stale-while-revalidate=60`, refreshed every 60s). Prices come from `smp.nj.sportsbook.fanduel.com/.../getMarketPrices` (uncached, max 80 market ids per call; in-play / starting-within-6h markets every call, the rest rotate).
- Cadence: one request per book per league every `DKFD_POLL_MS` (default 4000, min 3000) while a board is watching that league, `DKFD_IDLE_POLL_MS` (default 30000) otherwise. Errors back off exponentially (honours `Retry-After`); a 403 block backs off from 60s up to 15 min.
- `DKFD_LEAGUES` (default `NFL,NCAAF,MLB,NHL`). `DKFD_BOOKS` (default `draftkings,fanduel`).
- **Railway egress is blocked by DraftKings' Akamai** (403 Access Denied on every request from the odds-relay, Oct 7 2026; the same request works from the agent box). Production runs `DKFD_BOOKS=fanduel` until DraftKings has another egress (residential proxy or Kevin's computer).
- Routes: `/stream?venue=draftkings|fanduel&league=NFL` (SSE `quote` packets like Novig plus an `event: feed` heartbeat after every poll), `/board?venue=...` (JSON), `/health` → `dkfd`.
- Code lives inline in `odds-relay.js` (`dkfdFeed`) so the odds-relay watch paths pick up changes.

## Tester auto-funding (combo-testers service)

Each tester child keeps that tester's Kalshi Combos balance (Exchange 1) topped
up from their own Default balance (Exchange 0) with their own key
(`tester-funder.js`). Only Default -> Combos on the tester's own account; never
subaccounts, other users, or Kevin's money. Needs the tester key to have Full
access (`write`) or Transfers (`write::transfer`); the Supabase table
`combo_fund_moves` (aibetbuilder `sql/20261009_combo_fund_moves.sql`) must
exist, otherwise nothing moves (fail closed).

| Var (on combo-testers) | Default | Meaning |
| --- | --- | --- |
| `TESTER_AUTOFUND` | on | `0` = global kill switch, no tester moves at all |
| `TESTER_FUND_MAX_MOVE_USD` | 100 | per-move limit |
| `TESTER_FUND_DAILY_USD` | 250 | per-tester daily limit (ET day, from the log) |
| `TESTER_FUND_MIN_MOVE_USD` | 5 | smallest move |
| `TESTER_FUND_MAIN_FLOOR_USD` | 0 | Default balance always kept |
| `TESTER_FUND_INTERVAL_MIN` | 5 | check interval |

Cap: Combos available cash + unconfirmed moves never exceed the tester's
`combo_live_users.max_per_day_usd`. Per-tester off switches: the tester's kill
switch, owner Pause, `can_trade=false`, or a key without Transfers.
