# Railway: two services from this repo

Combo Locks and Unhedged RFQs are **separate processes**. They share the same GitHub repo, Supabase project, and Kalshi / Polymarket credentials. They must **not** share a Node event loop or the Combo Locks Kalshi quote HTTP pool.

Do **not** Railway-deploy from this PR unless asked. Create / wire the second service in the Railway dashboard (or CLI) when you are ready.

## Architecture

| Service | Entrypoint | What it owns | What it must not do |
|---|---|---|---|
| **Combo Locks** (existing worker) | `npm start` → `start-live.js` (`live-runner.js` + `fills-reader.js`) | Kalshi WS + Poly Retail RFQ **locks**: exact-lock quoting, confirm, fills, Miss tape (`combo_submissions`), reserves/caps, skip-tape, `combo_fills` | Unhedged `/markets` refresh, unhedged fill ticks, shadow-miss persist to `unhedged_rfqs` |
| **Unhedged RFQs** (new worker) | `npm run start:unhedged` → `start-unhedged.js` (`unhedged-runner.js`) | Own Kalshi WS + REST, own Poly listen, own MLB/NFL price cache, paper tape + fill tracking on `unhedged_rfqs` | Combo Lock quote POST / confirm. `UNHEDGED_RFQ_LIVE` stays off (paper/shadow only) |

`WORKER_MODE` (default **`combo`**):

- `combo` — Combo Locks only (Railway service 1)
- `unhedged` — Unhedged job only (Railway service 2; `start-unhedged.js` sets this)
- `all` — old one-process wiring (`npm run start:all`). Local / rollback only. Do not use in production.

Quote-watcher stays parked on both jobs (`sleep infinity`, or `QUOTE_WATCHER_WS=0` / `KALSHI_WS_OWNER=combo`). **Never** run `node quote-watcher.js` against the Combo Locks `KALSHI_KEY_ID` — Kalshi keeps one communications subscription per key.

## Kalshi communications WS — one subscriber per API key

Kalshi keeps **one** `communications` subscription per `KALSHI_KEY_ID`. A second `createKalshiWs` on that key receives `unsubscribed` after ~30–40s. The TCP socket stays up and pongs, so `kalshiWsAgeMs` looks healthy while Combo Lock quoting is dead (`rfq_created` stops).

**Production owner:** Combo Locks (`npm start` / `start-live.js`) — replica count **1**.

Do **not** multiplex two WS clients on one key. Reconnect-on-unsubscribe recovers a lone client if Kalshi drops the sub; it cannot make two processes share one subscription.

| Process | What to do |
|---|---|
| **quote-watcher** | Park on Railway (`sleep infinity`), or start with `QUOTE_WATCHER_WS=0` / `KALSHI_WS_OWNER=combo` (REST-only; no WS). |
| **Combo Locks replicas** | Never scale above 1. |
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

## Local

```bash
npm start                 # Combo Locks + fills-reader (WORKER_MODE=combo)
npm run start:unhedged    # Unhedged paper tape only
npm run start:all         # both in one process (escape hatch)
npm test
```

## Success checks after you deploy

- Combo Locks logs: `WORKER_MODE=combo` and `Unhedged /markets, fill ticks, and shadow miss are off`.
- Unhedged logs: `[UNHEDGED] starting — paper/shadow only` and `UNHEDGED_RFQ_LIVE=off`.
- Combo Locks still posts / confirms lock quotes. Unhedged never logs `QUOTED` / `CONFIRMED` for Combo Locks.
- `unhedged_rfqs` still receives in-scope unmatched MLB/NFL full-game moneyline paper rows when the Unhedged job is up.
