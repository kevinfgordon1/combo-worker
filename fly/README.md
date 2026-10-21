# Fly.io (region iad, Ashburn)

One Fly app per service (`kaygo-<svc>`) so each has its own secret scope.
All build from the root `Dockerfile`; `fly/<svc>.toml` sets the command and size.

- combo-worker: exactly 1 machine, never 2. Stop Railway's copy first.
- Polymarket keys: poly-worker, odds-relay, mm-paper, noboost-paper. combo-worker
  still reads them today (single-leg Polymarket REST, bucket-manager cash alert,
  balance-reporter); see the PR.
- Deploy workflow is staged at `fly/fly-deploy.workflow.yml` (workflow_dispatch only). Move it to `.github/workflows/` to enable; the bot token lacks GitHub `workflow` scope.
