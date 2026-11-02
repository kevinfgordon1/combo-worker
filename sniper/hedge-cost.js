// LOG-ONLY "hedge-cost" pricing for both Combo Snipers (Kevin Nov 2 2026). Quoting never reads it.
//
// The live fair is the inverse bet: each leg priced as 1 − (cost to bet AGAINST it), fee included.
// Hedge-cost asks the opposite question from the sniper's own side: we sell the parlay, so what does
// it cost to BUY each leg's Yes ourselves (cover the position), fee included, at the cheapest venue?
//   leg cost c_i = best fee-included $depth VWAP to buy the leg's own side across Kalshi (Yes on the
//                  team / No on the opponent), Polymarket US, Novig, ProphetX — the SAME books, the
//                  same 15s staleness and the same $depth rule as the live fair (each book already
//                  holds these ladders, so no extra API calls). Each venue's own fee: Kalshi taker
//                  0.07·p·(1−p), Polymarket US 0.0695·p·(1−p), Novig $0 pregame, ProphetX commission
//                  folded into its level prices.
//   parlay hedge prob P_h = Π c_i (independent legs, same as the fair).
//   hedge edge = the SNIPER_MIN_ROI formula (auto-sniper snipeEconomics) with fair := P_h at the
//                quote's own price / contracts / combo maker rate (Kalshi: series-fee.js rate;
//                Polymarket combos: 0).
// Per venue we also keep why it did not count: stale (older than 15s), depth (book thinner than
// $depth), top_only (no depth data), no_ask, overround (TD), missing (no book), venue_off.
'use strict';
const { snipeEconomics } = require('../auto-sniper');

const VENUES = ['kalshi', 'polymarket', 'novig', 'prophetx'];
const r6 = (x) => Math.round(x * 1e6) / 1e6;
function american(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}
const okCost = (s) => !!(s && s.used && s.reason === 'ok' && s.cost > 0 && s.cost < 1);

// sources: evalVenue-shaped rows for buying the leg's OWN side. -> { c, a, v, x:{venue:{r,c?,age?,via?}} }
function legHedge(sources, venues = VENUES) {
  const x = {};
  for (const v of VENUES) x[v] = { r: 'missing' };
  let best = null;
  for (const s of sources || []) {
    if (!s || !x[s.venue]) continue;
    const on = venues.includes(s.venue);
    const ok = okCost(s);
    const e = { r: on ? (s.reason || 'unknown') : 'venue_off' };
    if (ok) e.c = r6(s.cost);
    if (Number.isFinite(s.ageMs)) e.age = Math.round(s.ageMs);
    if (s.via) e.via = s.via;
    const cur = x[s.venue];
    // One entry per venue: a usable price beats an unusable one; the cheaper usable price wins.
    if (cur.r === 'missing' || (e.c != null && (cur.c == null || e.c < cur.c))) x[s.venue] = e;
    if (ok && on && (!best || s.cost < best.cost)) best = s;
  }
  return { c: best ? r6(best.cost) : null, a: best ? american(best.cost) : null, v: best ? best.venue : null, x };
}

// legs: [{ ticker, side, hedge: legHedge(...) }], q: our quoted Yes price (the customer pays q),
// n: contracts, makerRate: combo maker fee rate (same as the quote's economics), fair: live fair.
function parlayHedge(legs, { q, n, makerRate = 0, fair = null } = {}) {
  let p = 1;
  for (const l of legs || []) { const c = l && l.hedge && l.hedge.c; if (!(c > 0 && c < 1)) { p = null; break; } p *= c; }
  if (!legs || !legs.length) p = null;
  const out = { p: p != null ? r6(p) : null, a: p != null ? american(p) : null, roi: null, ev: null };
  if (p != null && q > 0 && q < 1 && n > 0) {
    const e = snipeEconomics({ fair: p, q, n, makerRate: makerRate || 0 });
    if (Number.isFinite(e.roi)) { out.roi = r6(e.roi); out.ev = Math.round(e.ev * 1e4) / 1e4; }
  }
  out.q = q != null ? r6(q) : null; out.n = n != null ? n : null; out.mr = makerRate || 0;
  if (fair != null) out.fair = r6(fair);
  out.legs = (legs || []).map((l) => ({ t: l.ticker, s: l.side || 'yes', ...(l.hedge || { c: null, x: {} }) }));
  return out;
}

// Re-price the same hedge object at another price / size (Polymarket confirm: our resting price).
function rescoreHedge(h, { q, n, makerRate = 0 } = {}) {
  if (!h) return null;
  const out = { ...h, q: q != null ? r6(q) : h.q, n: n != null ? n : h.n, mr: makerRate || 0, roi: null, ev: null };
  if (h.p > 0 && h.p < 1 && q > 0 && q < 1 && n > 0) {
    const e = snipeEconomics({ fair: h.p, q, n, makerRate: makerRate || 0 });
    if (Number.isFinite(e.roi)) { out.roi = r6(e.roi); out.ev = Math.round(e.ev * 1e4) / 1e4; }
  }
  return out;
}

// Compact per-quote form (Supabase disk IO: ~1M posted Kalshi quotes/day, so ~100 bytes, not ~800).
// { l: [[best venue code, fee-included cost (4dp), venue status codes in order kalshi,polymarket,novig,prophetx]], m: makerRate }
// venue codes: k kalshi, p polymarket, n novig, x prophetx.
// status codes: o ok, s stale (>15s), d depth (thinner than $depth), t top_only (no depth data), a no_ask,
//               v overround (TD), m missing (no book), f venue_off (not in the fair's venue list), u other.
const VCODE = { kalshi: 'k', polymarket: 'p', novig: 'n', prophetx: 'x' };
const RCODE = { ok: 'o', stale: 's', depth: 'd', top_only: 't', no_ask: 'a', overround: 'v', missing: 'm', venue_off: 'f' };
function compactHedge(h) {
  if (!h) return null;
  return {
    l: (h.legs || []).map((l) => [l.v ? VCODE[l.v] || l.v : null, l.c != null ? Math.round(l.c * 1e4) / 1e4 : null,
      VENUES.map((v) => RCODE[(l.x && l.x[v] && l.x[v].r) || 'missing'] || 'u').join('')]),
    m: h.mr || 0,
  };
}
// Ledger columns (migrations/20261102_sniper_hedge_cost_log.sql). Empty object when there is no hedge.
// Posted quotes: compact legs + the two numbers. Fills: the full detail (hedgeFillColumns).
// SNIPER_HEDGE_LOG=fills keeps only the numbers on quotes (full detail on fills unchanged).
function hedgeColumns(h, env = process.env) {
  if (!h) return {};
  const out = { hedge_prob: h.p != null ? h.p : null, hedge_roi: h.roi != null ? h.roi : null };
  if (String((env && env.SNIPER_HEDGE_LOG) || '1').toLowerCase() !== 'fills') out.hedge = compactHedge(h);
  return out;
}
function hedgeFillColumns(h, at) {
  if (!h) return {};
  return { hedge_fill: { ...h, at: new Date(at != null ? at : Date.now()).toISOString() } };
}

// Never throws: hedge logging must not be able to affect quoting.
function safe(fn) { try { return fn(); } catch (_) { return null; } }
// SNIPER_HEDGE_LOG=0 turns the whole thing off (both snipers). Default on.
const hedgeLogOn = (env = process.env) => String((env && env.SNIPER_HEDGE_LOG) || '1') !== '0';

module.exports = { hedgeLogOn, VENUES, legHedge, parlayHedge, rescoreHedge, compactHedge, hedgeColumns, hedgeFillColumns, american, safe };
