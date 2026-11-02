# Fly.io (region iad, Ashburn)

One Fly app per service (`kaygo-<svc>`) so each has its own secret scope.
All build from the root `Dockerfile`; `fly/<svc>.toml` sets the command and size.

- combo-worker: exactly 1 machine, never 2. Stop Railway's copy first.
- Polymarket keys: poly-worker, odds-relay, mm-paper, noboost-paper. combo-worker
  still reads them today (single-leg Polymarket REST, bucket-manager cash alert,
  balance-reporter); see the PR.
- Deploy workflow is staged at `fly/fly-deploy.workflow.yml` (workflow_dispatch only). Move it to `.github/workflows/` to enable; the bot token lacks GitHub `workflow` scope.

## combo-testers (kaygo-combo-testers)

Combo Locks quoting for non-Kevin users (`npm run start:testers`), moved from
Railway on Oct 25 2026. One machine, iad. Secrets: `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY` only (tester Kalshi keys are read per user from
Supabase). Never set Kevin's Kalshi or any Polymarket keys on this app.
Deploy: `flyctl deploy . -c fly/combo-testers.toml -a kaygo-combo-testers --local-only --ha=false`.

## prophetx-sandbox (kaygo-prophetx-sandbox)

ProphetX SANDBOX parlay RFQ quoter (`node start-prophetx.js`), formerly Railway
`prophetx-worker` (stopped Oct 21 2026 when Railway was removed). One machine, iad,
no public ports. Secrets (names only): `PROPHETX_SANDBOX_API_KEY`,
`PROPHETX_SANDBOX_SECRET_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
Never set the production ProphetX key (relay only), any Kalshi, Polymarket or Novig key;
`px/guard.js` refuses to start if one is present. See docs/PROPHETX-WORKER.md.
Deploy: `flyctl deploy . -c fly/prophetx-sandbox.toml -a kaygo-prophetx-sandbox --local-only --ha=false`.
