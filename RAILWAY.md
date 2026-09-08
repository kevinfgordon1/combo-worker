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

Quote-watcher stays parked on both jobs.

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

3. Copy the shared env vars onto the Unhedged service (same values):

   - `KALSHI_KEY_ID`, `Kalshi_combo_key` (or `KALSHI_PRIVATE_KEY`)
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
