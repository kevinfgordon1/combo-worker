# NCAAB canonical team table

One identity per D1 men's basketball school: the **ESPN team id**. Every venue's codes and names are aliases.

| File | What |
|---|---|
| `ncaab-teams.json` | Generated table: 365 D1 teams, `aliases[source]` (`kalshi` codes/names/teamIds, `kalshiFutures` (KXMARMAD), `polymarket` abbrs/names/teamIds, `polymarketFutures` (cbb-champ slugs), `novig`, `prophetx`, `underdog` abbrs/names/ids, `oddsapi`, `books` (sportsbook futures names), `manual`), `ambiguous` codes, known `nonD1` names, learned `kalshiGames`. Shared with aibetbuilder (`lib/ncaab-teams.json`). |
| `ncaab-teams.js` | Runtime resolver (same file in aibetbuilder `lib/`): `resolveTeam`, `resolveGame`, `splitKalshiBlob`, `setSchedule` / `addSchedule` (ESPN context). |
| `ncaab-team-overrides.json` | Manual aliases (`names`, per-source `aliases`, `NON_D1`). |
| `scripts/ncaab-teams-capture.js` | Live capture of every source (public endpoints; Odds API key from env; ProphetX only through the relay). |
| `scripts/gen-ncaab-teams.js` | Builds the table + `ncaab-teams-report.json` (coverage, unmatched, ESPN-schedule check). |
| `scripts/check-ncaab-teams.js` | Cron check: exit 2 + list when a live name does not resolve (`--telegram` to alert). |

Ambiguous codes (Kalshi `OAK` = Oakland **and** Oakwood, a non-D1 school) are never guessed and never dropped:
they resolve with the opponent + tip from the ESPN schedule (or the Kalshi game learned at generation time).

Refresh: `npm run ncaab:teams` (live capture, regenerates json + fixture), run tests, copy `ncaab-teams.json` and
`ncaab-teams.js` to aibetbuilder (`npm run sync:ncaab-teams` there). New unmatched name: add it to
`ncaab-team-overrides.json`, regenerate.
