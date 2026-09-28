# Railway: services from this repo

Combo Locks and Unhedged RFQs are **separate processes**. They share the same GitHub repo, Supabase project, and Kalshi / Polymarket credentials. They must **not** share a Node event loop or the Combo Locks Kalshi quote HTTP pool.

Do **not** Railway-deploy from this PR unless asked. Create / wire the second service in the Railway dashboard (or CLI) when you are ready.

## Architecture

| Service | Entrypoint | What it owns | What it must not do |
|---|---|---|---|
| **Combo Locks** (existing worker) | `npm start` → `start-live.js` (`live-runner.js` + `fills-reader.js`) | Kalshi WS + Poly Retail RFQ **locks**: exact-lock quoting, confirm, fills, Miss tape (`combo_submissions`), reserves/caps, skip-tape, `combo_fills` | Unhedged `/markets` refresh, unhedged fill ticks, shadow-miss persist to `unhedged_rfqs` |
| **Unhedged RFQs** (new worker) | `npm run start:unhedged` → `start-unhedged.js` (`unhedged-runner.js`) | Own Kalshi WS + REST, own Poly listen, own MLB/NFL price cache, paper tape + fill tracking on `unhedged_rfqs` | Combo Lock quote POST / confirm. `UNHEDGED_RFQ_LIVE` stays off (paper/shadow only) |
| **Odds relay** (board fanout) | `npm run start:odds-relay` → `start-odds-relay.js` | Polymarket US markets websocket, international CLOB fallback, Kalshi public REST (and a market-data websocket only with its own key). SSE for the New Odds Board | Combo Locks, Unhedged, `WORKER_MODE`, Kalshi `communications`. Do not copy Combo Locks `KALSHI_KEY_ID` |
| **Polymarket relay** (Live Trading Desk egress) | `npm run start:poly-relay` → `start-poly-relay.js` | Pass-through HTTP to `api.polymarket.us` and `gateway.polymarket.us` only. Shared-secret gate and a 15 req/s governor. Holds no Polymarket key | Combo Locks, Unhedged, odds relay, `WORKER_MODE`, Kalshi, signing. Do not copy `POLYMARKET_KEY_ID` / `POLYMARKET_SECRET_KEY` |

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

## Polymarket US relay (Live Trading Desk)

Vercel’s shared egress is what Polymarket’s Cloudflare answers with error **1015**. This process is a separate Railway service so the Live Trading Desk’s Polymarket US calls leave from Railway’s egress instead. It is not part of Combo Locks. `start-poly-relay.js` does not set `WORKER_MODE` and does not load `live-runner`, `fills-*`, `kalshi-ws`, `quote-hot`, `rfq`, `reserve`, or `kalshi-fill-confirm`.

Do **not** Railway-deploy it from a PR unless asked. Add the service in the dashboard when you are ready. This repo does not change Railway itself.

### Service

- **Name:** `poly-relay`
- **Start command:** `npm run start:poly-relay` (or `node start-poly-relay.js`)
- **Replica count:** **1**. The governor is per process. A second replica can add another 15 req/s onto the same static address and trip Polymarket’s 20 req/s per-IP cap.
- **WORKER_MODE:** leave unset. This entrypoint never starts the combo event loop.
- **PORT:** Railway sets this. Local default is `8790`.
- **Health check path (optional):** `GET /healthz` (no secret).
- **Do not copy** `POLYMARKET_KEY_ID`, `POLYMARKET_SECRET_KEY`, Kalshi keys, or Supabase keys. aibetbuilder signs; this process only forwards.

| Env | Default | Meaning |
|---|---|---|
| `POLY_RELAY_SECRET` | unset | Shared secret, request header `X-Poly-Relay-Secret`. At least 16 characters, one line. Same value on the Vercel project. Unset or shorter → proxy requests return `503` and nothing is forwarded. |
| `POLY_RELAY_RPS` | `15` | Token-bucket refill rate. Clamped to 1–19 so the relay stays under Polymarket’s 20 req/s per-IP limit. |
| `POLY_RELAY_BURST` | same as `POLY_RELAY_RPS` | Bucket size. Clamped to 1–19. |
| `POLY_RELAY_MAX_BODY` | `1048576` | Max request body in bytes (1 KiB–8 MiB). Larger requests return `413`. |
| `POLY_RELAY_TIMEOUT_MS` | `15000` | Upstream abort. Clamped to 1–60 seconds. Timeout → `504`. |

`GET /healthz` returns `{ ok, service, uptimeSec, egressIp }` and no secret. `egressIp` is one public address looked up at startup (`https://api.ipify.org`). Lookup failure leaves it `null`; the process still listens.

Once a minute the process logs counts only: `requests`, `forwarded`, `rejected`, `local_429`, `upstream_429`, `cloudflare_1015`. It does not log paths, bodies, `X-PM-*` headers, or the relay secret.

### Static outbound IP

Polymarket rate-limits by source IP. On a Railway plan that includes it (Pro), give **this** service a static outbound address. Leave Combo Locks on its current egress.

1. Open the `poly-relay` service → **Settings** → **Networking**.
2. Turn on **Enable Static IPs**.
3. Note the IPv4 addresses for the service region. Current Pro assigns three load-balanced addresses (high availability), not a single legacy address.
4. Redeploy so outbound traffic uses them.

`/healthz` reports whichever address the one startup lookup used. The dashboard list is the full set. Hobby plans do not get this toggle; shared egress can still draw a 1015. Enabling the toggle is a dashboard step. This pull request does not turn it on.

### Same repo as combo-worker

A service created from this repo’s `main` branch redeploys when combo-worker does. To split them, either:

- Set **Watch Paths** on `poly-relay` (service Settings → Build) so only relay files trigger a deploy, for example `/poly-relay.js`, `/start-poly-relay.js`, `/poly-relay.test.js`, `/package.json`. Set watch paths on combo-worker as well if a relay-only commit should not redeploy the quoter. Empty watch paths mean every `main` push redeploys that service.
- Or point `poly-relay` at its own branch instead of `main`. Relay fixes have to land on that branch; combo-worker can stay on `main`.

### Request contract (aibetbuilder)

Signing stays in aibetbuilder `api/polymarket-us-auth.js`. The message is `timestamp + METHOD + path`:

- `timestamp` is the `X-PM-Timestamp` header (decimal milliseconds).
- `METHOD` is the uppercase method.
- `path` is the pathname only. One 401 retry, when the call has a query string, re-signs with the pathname and the raw query (`path+query`).
- The host is not in the signature. The body is not in the signature.

`api/polymarket-us-client.js` (the client `/api/live-trading-desk` uses) sends signed calls to `https://api.polymarket.us` and unsigned metadata to `https://gateway.polymarket.us`. Those two hostnames are the entire allowlist. Anything else, including `clob.polymarket.com` and `gamma-api.polymarket.com`, is `403`.

Send the Polymarket request to the relay with the **same method, path, and query** that were signed. Add two hop headers. The relay strips those, strips hop-by-hop headers (`Connection` and the names it lists, `Transfer-Encoding`, `Keep-Alive`, `Host`, …), and strips `X-Forwarded-*`. It forwards `X-PM-Access-Key`, `X-PM-Timestamp`, `X-PM-Signature`, `Accept`, `Content-Type`, and the body bytes unchanged to `https://{host}{path}{query}`. It does not follow redirects (`redirect: manual`), so a 3xx cannot leave the allowlist.

```
POST /v1/orders HTTP/1.1
Host: <poly-relay public host>
X-Poly-Relay-Secret: <POLY_RELAY_SECRET>
X-Poly-Relay-Host: api.polymarket.us
X-PM-Access-Key: <aibetbuilder key id>
X-PM-Timestamp: <ms>
X-PM-Signature: <ed25519 over timestamp + POST + /v1/orders>
Content-Type: application/json

{...order json...}
```

`X-Poly-Relay-Host` is the hostname only: `api.polymarket.us` or `gateway.polymarket.us`. Not a URL, not a port, not a path.

Gateway reads (no `X-PM-*` headers) use the same shape, for example `GET /v2/leagues/nfl/events?limit=80&active=true&closed=false` with `X-Poly-Relay-Host: gateway.polymarket.us`. Public slug and BBO reads (`/v1/market/slug/…`, `/v1/markets/…/bbo`) go to the gateway first in the desk client, then fall back to the signed API host. Point both at the relay so they share the Railway egress address.

A fetch wrapper around the existing client keeps the signed bytes intact:

```js
async function relayFetch(url, init = {}) {
  const target = new URL(url);
  const headers = new Headers(init.headers || {});
  headers.set('X-Poly-Relay-Secret', process.env.POLY_RELAY_SECRET);
  headers.set('X-Poly-Relay-Host', target.hostname);
  const relay = String(process.env.POLY_RELAY_URL || '').replace(/\/$/, '');
  return fetch(relay + target.pathname + target.search, {
    method: init.method || 'GET',
    headers,
    body: init.body,
  });
}
```

Pass `relayFetch` as `fetchImpl` on `createPolymarketUsClient`. On Vercel set `POLY_RELAY_URL` to the Railway public origin (no trailing slash) and `POLY_RELAY_SECRET` to the same secret. Do not put the secret in a `VITE_` variable.

| Relay response | Meaning |
|---|---|
| Upstream status, headers, body | Forwarded as-is, including `429` and `Retry-After`. Body is not rewritten. Cloudflare 1015 stays in that body; the relay only counts it. |
| `429` `{"ok":false,"error":"relay_rate_limited"}` plus `Retry-After` | Local token bucket. Polymarket was not called. |
| `401` `unauthorized` | Missing or wrong `X-Poly-Relay-Secret`. |
| `403` `upstream_not_allowed` | Host missing or not on the allowlist, or an unsafe path. |
| `413` `body_too_large` | Over `POLY_RELAY_MAX_BODY`. |
| `502` / `504` | Upstream network error / timeout. |
| `503` `relay_not_configured` | `POLY_RELAY_SECRET` unset or shorter than 16 characters. |

`/healthz` does not require the secret.

## Local

```bash
npm start                 # Combo Locks + fills-reader (WORKER_MODE=combo)
npm run start:unhedged    # Unhedged paper tape only
npm run start:all         # both in one process (escape hatch)
npm run start:odds-relay  # board relay only (port 8787 or $PORT)
npm run start:poly-relay  # Polymarket US HTTP relay only (port 8790 or $PORT)
npm test
```

## Success checks after you deploy

- Combo Locks logs: `WORKER_MODE=combo` and `Unhedged /markets, fill ticks, and shadow miss are off`.
- Unhedged logs: `[UNHEDGED] starting — paper/shadow only` and `UNHEDGED_RFQ_LIVE=off`.
- Combo Locks still posts / confirms lock quotes. Unhedged never logs `QUOTED` / `CONFIRMED` for Combo Locks.
- `unhedged_rfqs` still receives in-scope unmatched MLB/NFL full-game moneyline paper rows when the Unhedged job is up.
