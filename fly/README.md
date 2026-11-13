# Fly.io (region iad, Ashburn)

One Fly app per service (`kaygo-<svc>`) so each has its own secret scope.
All build from the root `Dockerfile`; `fly/<svc>.toml` sets the command and size.

- combo-worker: exactly 1 machine, never 2. Stop Railway's copy first.
- Polymarket keys: poly-worker, odds-relay, mm-paper, noboost-paper. combo-worker
  still reads them today (single-leg Polymarket REST, bucket-manager cash alert,
  balance-reporter); see the PR.
- novig-worker (`kaygo-novig-worker`, `fly/novig-worker.toml`): Novig RFQ maker.
  One machine, iad. Shadow by default. Secrets by name are in `docs/NOVIG-RFQ.md`.
  It does not use Kalshi or Polymarket keys. Not deployed with the app toml.
- Deploy workflow is staged at `fly/fly-deploy.workflow.yml` (workflow_dispatch only). Move it to `.github/workflows/` to enable; the bot token lacks GitHub `workflow` scope.

## combo-testers (kaygo-combo-testers)

Combo Locks quoting for non-Kevin users (`npm run start:testers`), moved from
Railway on Oct 25 2026. One machine, iad. Secrets: `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY` only (tester Kalshi keys are read per user from
Supabase). Never set Kevin's Kalshi or any Polymarket keys on this app.
Deploy: `flyctl deploy . -c fly/combo-testers.toml -a kaygo-combo-testers --local-only --ha=false`.
