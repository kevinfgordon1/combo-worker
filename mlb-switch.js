'use strict';
// MLB on/off switch (Kevin Oct 30 2026: season over, turn off all baseball lines "for now").
// Default OFF. Set MLB_ENABLED=1 (Fly [env] or secret) to bring MLB back next season; nothing else
// was deleted. Read by the odds relay (Polymarket / Kalshi / Novig / ProphetX / DK-FD / Underdog
// league lists) and the game-schedule sync (ESPN MLB pulls).
const mlbOn = (env = process.env) => /^(1|true|yes|on)$/i.test(String((env && env.MLB_ENABLED) || '').trim());
const withoutMlb = (list, env = process.env) => (mlbOn(env) ? list.slice() : list.filter((l) => String(l).toUpperCase() !== 'MLB'));
module.exports = { mlbOn, withoutMlb };
