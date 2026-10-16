// ProphetX partner API moneyline depth for the PM live inverse fair (port of aibetbuilder
// lib/book-depth.js fetchProphetXDepth). READ-ONLY GETs. Off (returns []) without credentials:
// PROPHETX_API_KEY, or PROPHETX_ACCESS_KEY + PROPHETX_SECRET_KEY.
'use strict';
const BASE = () => process.env.PROPHETX_API_BASE || 'https://cash.api.prophetx.co/partner';

function hasProphetXCreds(env = process.env) { return !!(env.PROPHETX_API_KEY || (env.PROPHETX_ACCESS_KEY && env.PROPHETX_SECRET_KEY)); }
function decToAmerican(d) { if (!(d > 1)) return null; return d >= 2 ? Math.round((d - 1) * 100) : -Math.round(100 / (d - 1)); }

function createProphetXClient({ env = process.env, fetchImpl = fetch } = {}) {
  let token = null; let tokenAt = 0;
  async function auth() {
    if (env.PROPHETX_API_KEY) return env.PROPHETX_API_KEY;
    if (!(env.PROPHETX_ACCESS_KEY && env.PROPHETX_SECRET_KEY)) return null;
    if (token && Date.now() - tokenAt < 10 * 60 * 1000) return token;
    const r = await fetchImpl(`${BASE()}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_key: env.PROPHETX_ACCESS_KEY, secret_key: env.PROPHETX_SECRET_KEY }) });
    const j = r.ok ? await r.json() : null;
    token = (j && j.data && j.data.access_token) || null; tokenAt = Date.now();
    return token;
  }
  const get = async (path, a) => { const r = await fetchImpl(BASE() + path, { headers: { authorization: a } }); if (!r.ok) throw new Error(`prophetx ${path.split('?')[0]} -> ${r.status}`); return r.json(); };
  // -> [{ away, home, start, side, key, levels:[{american,size}] }]
  async function nflMoneylines() {
    const a = await auth();
    if (!a) return [];
    const ej = await get('/affiliate/get_sport_events', a);
    const evs = ((ej.data && (ej.data.sport_events || ej.data.events)) || ej.events || []).filter((e) => /nfl/i.test(`${e.tournament_name || ''} ${e.sport_name || ''} ${e.league || ''}`));
    const out = [];
    for (const ev of evs) {
      const mj = await get(`/v3/affiliate/get_markets?event_id=${encodeURIComponent(ev.event_id)}&market_types=moneyline`, a);
      const markets = Array.isArray(mj.data) ? mj.data : ((mj.data && mj.data[ev.event_id]) || []);
      for (const m of markets) {
        const groups = new Map();
        for (const s of (m.selections || []).flat()) { if (!s || !s.name) continue; const g = groups.get(s.name) || []; g.push(s); groups.set(s.name, g); }
        for (const [name, g] of groups) {
          const levels = g.map((s) => ({ american: decToAmerican(parseFloat(s.price)), size: parseFloat(s.quantity) })).filter((l) => l.american != null && l.size > 0);
          if (levels.length) out.push({ away: ev.away_team, home: ev.home_team, start: ev.scheduled || ev.start_time || ev.scheduled_time, side: name, key: `${ev.event_id}:${name}`, levels });
        }
      }
      await new Promise((r) => setTimeout(r, 120)); // stay well under partner rate limits
    }
    return out;
  }
  return { nflMoneylines };
}

module.exports = { createProphetXClient, hasProphetXCreds };
