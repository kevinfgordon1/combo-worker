// Polymarket US + ProphetX depth ladders from the odds relay's READ-ONLY /board
// (GET only, no key in this process). The relay holds the production ProphetX key
// (read-only); this sandbox quoter never does. Polymarket US is the venue Kevin can
// use (book-depth's own 'polymarket' path is international Polymarket, not US).
//
// Output matches book-depth resolveLegsDepth rows: { venue, levels:[{american,size}], reason, ageMs }
//   levels: fee-included opposing ASK ladder, size = $ stake, best first.
//   Polymarket US fee 0.0695·p·(1−p); ProphetX 2% of net winnings (book-depth applyVenueFee).
// Freshness (same as the sniper): Polymarket US = max(confirmed_at, updated_at);
// ProphetX = board poll time while the relay's ProphetX socket is flowing (newest quote on the
// board changed within 15 s of the poll; /health takes ~19 s to answer), else that quote's updated_at.
// Older than 15 s → reason 'stale', no levels.
'use strict';
const bd = require('./vendor/book-depth');

const LEAGUE_OF_SPORT = {
  americanfootball_nfl: 'NFL',
  americanfootball_ncaaf: 'NCAAF',
  basketball_nba: 'NBA',
  basketball_ncaab: 'NCAAB',
};
const BET_TYPE = { ML: 'moneyline', SPR: 'spread', TOT: 'total' };
const RELAY_VENUES = ['polymarket', 'prophetx'];
const FEED_REF_MAX_AGE_MS = 10 * 60 * 1000;

// Pure: one relay quote → fee-included ask levels for buying that quote's side.
function levelsFromQuote(venue, q) {
  const raw = Array.isArray(q.depth) && q.depth.length ? q.depth : [{ odds: q.odds, size: q.size }];
  const out = [];
  for (const d of raw) {
    const p = Number(d && d.odds);
    const z = Number(d && d.size);
    if (!(p > 0 && p < 1) || !(z > 0)) continue;
    const american = bd.probToAmerican(p);
    if (american == null) continue;
    // Polymarket US size = contracts ($1 each) → $ stake = p·size. ProphetX size = $ stake already.
    out.push({ american, size: venue === 'polymarket' ? p * z : z });
  }
  return bd.sortAsksBestFirst(out, venue);
}

// Pure: the board's newest change is within staleMs of when it was read => the feed is live.
function boardLive(quotes, boardAt, staleMs) {
  let newest = 0;
  for (const q of quotes || []) { const t = Date.parse((q && q.updated_at) || '') || 0; if (t > newest) newest = t; }
  return newest > 0 && boardAt - newest <= staleMs;
}

function sideOf(q) { return String(q.side || ''); }
function eventKey(q) { return `${q.away}|${q.home}|${q.start}`; }

// Pure: the relay quote that is the OPPOSING selection for this leg (book-depth leg shape).
function pickOppQuote(venue, quotes, leg) {
  const sel = bd.parseOppSelection({ ...leg, bestOppBook: 'kalshi' }); // venue-agnostic parse
  if (!sel || !BET_TYPE[sel.market]) return { q: null, reason: 'relay_unparsed' };
  const betType = BET_TYPE[sel.market];
  const pool = (quotes || []).filter((q) => q && q.bet_type === betType && !q.is_alt
    && !(venue === 'polymarket' && q.feed && q.feed !== 'polymarket-us'));
  // Event: both teams match DIFFERENT words (#550 rule); strongest name match wins, then start time.
  const byEvent = new Map();
  for (const q of pool) { const k = eventKey(q); if (!byEvent.has(k)) byEvent.set(k, { q, list: [] }); byEvent.get(k).list.push(q); }
  let top = 0; let cands = [];
  for (const ev of byEvent.values()) {
    const sc = bd.eventMatchScore(`${ev.q.away} @ ${ev.q.home}`, sel.away, sel.home);
    if (sc > top) { top = sc; cands = [ev]; } else if (sc > 0 && sc === top) cands.push(ev);
  }
  if (!cands.length) return { q: null, reason: `${venue}_unmatched_event` };
  const ev = bd.pickEventByStart(cands, sel.commence_time, (e) => e.q.start);
  if (!ev) return { q: null, reason: `${venue}_unmatched_event` };
  let q = null;
  if (sel.side === 'ml') {
    if (sel.team === 'Draw' || sel.buySide === 'no') return { q: null, reason: `${venue}_unsupported_side` };
    q = bd.pickBestTeamMatch(sel.team, ev.list, sideOf);
    // The picked side must be the opponent, not the other team in the event.
    const other = sel.team === sel.away ? sel.home : sel.away;
    if (q && other && bd.teamMatchScore(sideOf(q), other) > bd.teamMatchScore(sideOf(q), sel.team)) q = null;
  } else if (sel.side === 'spread') {
    const rows = ev.list.filter((x) => bd.lineEqual(x.line, sel.line));
    q = bd.pickBestTeamMatch(sel.team, rows, sideOf);
  } else {
    const want = sel.side === 'over' ? /^over$/i : /^under$/i;
    q = ev.list.find((x) => want.test(sideOf(x)) && bd.lineEqual(x.line, sel.line)) || null;
  }
  if (!q) return { q: null, reason: `${venue}_unmatched_market` };
  return { q, reason: 'ok' };
}

// The relay answers in 2-4 s (17 s seen on /health), longer than the 5 s price timeout, so
// boards are polled in the background (every pollMs, only boards a leg asked for in the last
// activeMs) and legs read the last snapshot. A leg's first ask for a board waits for one fetch.
function createRelayDepth({ base, fetch: f = globalThis.fetch, now = Date.now, staleMs = 15_000, timeoutMs = 8000, pollMs = 5000, activeMs = 10 * 60_000, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  const root = String(base || '').replace(/\/+$/, '');
  const snap = new Map(); // path -> { at, json }
  const inflight = new Map();
  const active = new Map(); // path -> last asked
  let timer = null;
  function fetchPath(path) {
    if (inflight.has(path)) return inflight.get(path);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const p = f(`${root}${path}`, { method: 'GET', headers: { accept: 'application/json' }, signal: ctrl.signal })
      .then(async (r) => { if (!r.ok) throw new Error(`relay ${path} HTTP ${r.status}`); const json = await r.json(); snap.set(path, { at: now(), json }); return snap.get(path); })
      .finally(() => { clearTimeout(t); inflight.delete(path); });
    inflight.set(path, p);
    return p;
  }
  async function getSnap(path, maxAgeMs) {
    active.set(path, now());
    const hit = snap.get(path);
    if (hit && now() - hit.at <= maxAgeMs) return hit;
    if (hit && inflight.has(path)) return hit; // a refresh is running; use what we have (freshness checked per quote)
    try { return await fetchPath(path); } catch (e) { if (hit) return hit; throw e; }
  }
  function tick() {
    const t = now();
    for (const [path, askedAt] of active) {
      if (t - askedAt > activeMs) { active.delete(path); continue; }
      fetchPath(path).catch(() => {}); // one in flight per path (dedup), so a slow relay is never piled on
    }
  }
  function start() { if (!timer && root) { timer = setIntervalFn(tick, pollMs); if (timer && timer.unref) timer.unref(); } }
  function stop() { if (timer) clearIntervalFn(timer); timer = null; }
  // Guard reference reads: never block a leg and never join the fast poll; refresh at most once a minute.
  const passiveAt = new Map();
  function peek(path, refreshMs = 60_000) {
    const hit = snap.get(path);
    if ((!hit || now() - hit.at > refreshMs) && now() - (passiveAt.get(path) || 0) > refreshMs) {
      passiveAt.set(path, now());
      fetchPath(path).catch(() => {});
    }
    return hit ? hit.json : null;
  }

  async function venueDepth(venue, leg) {
    if (!root) return { venue, levels: [], reason: 'relay_off' };
    const league = LEAGUE_OF_SPORT[String(leg.sport || '')];
    if (!league) return { venue, levels: [], reason: 'relay_league_unsupported' };
    let quotes = [];
    let boardAt = 0;
    let pxLive = false;
    try {
      const bs = await getSnap(`/board?venue=${venue}&league=${league}`, pollMs);
      boardAt = bs.at;
      quotes = (bs.json && bs.json.quotes) || [];
      if (venue === 'polymarket' && leg.market !== 'ML') {
        const l = await getSnap(`/lines?venue=polymarket&league=${league}`, pollMs).catch(() => null);
        if (l && l.json && Array.isArray(l.json.quotes)) quotes = quotes.concat(l.json.quotes);
      }
      if (venue === 'prophetx') pxLive = boardLive(quotes, boardAt, staleMs);
    } catch (e) {
      return { venue, levels: [], reason: `relay_error:${e.message}` };
    }
    const { q, reason } = pickOppQuote(venue, quotes, leg);
    if (!q) return { venue, levels: [], reason };
    const changed = Date.parse(q.updated_at || '') || 0;
    const at = venue === 'polymarket' ? Math.max(Date.parse(q.confirmed_at || '') || 0, changed) : (pxLive ? boardAt : changed);
    const ageMs = at ? now() - at : Infinity;
    if (!(ageMs <= staleMs)) return { venue, levels: [], reason: 'stale', ageMs };
    return { venue, levels: levelsFromQuote(venue, q), reason: 'ok', ageMs };
  }

  // Top-of-book feed price (fee-included American) the relay has for this leg's opposing
  // selection on a direct venue (kalshi / novig): the reference for the rogue-ladder guard.
  // Ignored if the quote has not changed in FEED_REF_MAX_AGE_MS.
  async function feedTop(venue, leg) {
    if (!root) return null;
    const league = LEAGUE_OF_SPORT[String(leg.sport || '')];
    if (!league) return null;
    const j = peek(`/board?venue=${venue}&league=${league}`);
    const { q } = pickOppQuote(venue, (j && j.quotes) || [], leg);
    if (!q) return null;
    const changed = Date.parse(q.updated_at || '') || 0;
    if (!changed || now() - changed > FEED_REF_MAX_AGE_MS) return null;
    const a = bd.probToAmerican(Number(q.odds));
    return a == null ? null : bd.applyVenueFee(venue, a);
  }

  return { venueDepth, feedTop, start, stop, _snap: snap };
}

module.exports = { createRelayDepth, pickOppQuote, levelsFromQuote, boardLive, LEAGUE_OF_SPORT, RELAY_VENUES };
