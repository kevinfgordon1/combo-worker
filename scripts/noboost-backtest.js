#!/usr/bin/env node
// Backtest the no-boost NFL moneyline combo quoter against historical Kalshi RFQ fills.
// PAPER ONLY — reads local JSON, prints a report, sends nothing.
//
//   node scripts/noboost-backtest.js --data /workspace/nb-data/raw [--margins 0,.025,.05,.075,.1,.15]
//
// Inputs (built by scripts/noboost-data/*):
//   prints_nfl.json   [{k,t,c,y,legs:["6OCT04TENBAL-BAL:yes",…]}]  one row per executed RFQ print
//                     on an all-KXNFLGAME combo (t epoch s, c contracts, y YES price paid by the taker)
//   E_candles.json    {ticker:{c:[[end_ts,yes_ask_close,yes_bid_close]…],res,close}}   1-min Kalshi candles
//   G_meta.json       {ticker:{occ,res,st}}                       occurrence_datetime + settlement result
//
// Methodology (honest limits are printed in the report):
//   • "Won" = our quote YES price <= the YES price the taker actually paid. The taker takes the
//     lowest YES quote, so a lower quote beats the print. Ties counted separately (not won).
//   • Only taker_side=yes prints (taker BUYS the combo, we SELL it) are tested; the report counts the rest.
//   • Book = last 1-minute Kalshi candle close at/before the print (<=10 min old). Polymarket
//     history is not available, so the inverse uses Kalshi only (Poly adds a second venue live).
//   • Games with kickoff (Kalshi occurrence_datetime − 3h) <= print time are excluded (pregame only).
//   • Settled P&L uses real game results; unsettled stays open.
'use strict';
const fs = require('fs');
const path = require('path');
const { classifyNfl } = require('./../noboost-shadow');
const q = require('./../noboost-quote');
const { createRiskBook, RISK_DEFAULTS } = require('./../noboost-risk');

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const DATA = arg('data', '/workspace/nb-data/raw');
const MARGINS = String(arg('margins', '0,0.025,0.05,0.075,0.1,0.15')).split(',').map(Number);
const MAX_AGE = 600;
const SINCE_CREATED = arg('since-created', null); // ISO: only combos created at/after (full trade coverage)
const SINCE_MS = SINCE_CREATED ? Date.parse(SINCE_CREATED) / 1000 : 0;

const prints = JSON.parse(fs.readFileSync(path.join(DATA, 'prints_nfl.json'), 'utf8'));
const candles = JSON.parse(fs.readFileSync(path.join(DATA, 'E_candles.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'G_meta.json'), 'utf8'));

// per-ticker sorted arrays
const series = new Map();
for (const [tk, v] of Object.entries(candles)) {
  const rows = v.c.slice().sort((a, b) => a[0] - b[0]);
  series.set(tk, { ts: rows.map((r) => r[0]), ask: rows.map((r) => Number(r[1])), bid: rows.map((r) => Number(r[2])) });
}
function lookup(tk, t) {
  const s = series.get(tk);
  if (!s) return null;
  let lo = 0; let hi = s.ts.length - 1; let ix = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s.ts[m] <= t) { ix = m; lo = m + 1; } else hi = m - 1; }
  if (ix < 0 || t - s.ts[ix] > MAX_AGE) return null;
  const ask = s.ask[ix]; const bid = s.bid[ix];
  return {
    ask: ask > 0.005 && ask < 0.995 ? ask : null,
    bid: bid > 0.005 && bid < 0.995 ? bid : null,
  };
}
const eventOf = (tk) => tk.slice(0, tk.lastIndexOf('-'));
const eventTeams = new Map();
for (const tk of Object.keys(meta)) {
  const e = eventOf(tk); const l = eventTeams.get(e) || []; l.push(tk); eventTeams.set(e, l);
}
function oppTicker(tk) { const l = eventTeams.get(eventOf(tk)) || []; return l.find((x) => x !== tk) || null; }
const kickoffOf = (tk) => { const m = meta[tk]; return m && m.occ ? Date.parse(m.occ) / 1000 - 3 * 3600 : null; };

function sourceAt(t) {
  const quotes = (tk) => {
    const x = tk ? lookup(tk, t) : null;
    return x && x.ask != null ? [{ venue: 'kalshi', yesProb: x.ask, bid: x.bid, key: tk }] : [];
  };
  return {
    opponentQuotes: (leg) => quotes(oppTicker(leg.id)),
    ownQuotes: (leg) => quotes(leg.id),
  };
}

const fmt = q.fmtAm;
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : 'n/a');
const money = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

// ── 1. classify + price every print once (margin-independent parts) ──────────
const rows = [];
const skip = {};
const bump = (k) => { skip[k] = (skip[k] || 0) + 1; };
for (const p of prints) {
  if (SINCE_MS && Date.parse(p.cr) / 1000 < SINCE_MS) { bump('before_since'); continue; }
  const legKeys = p.legs.map((l) => `KXNFLGAME-2${l}`);
  const cls = classifyNfl({ legKeys }, 'kalshi');
  if (!cls.ok) { bump(cls.reason); continue; }
  if (p.side && p.side !== 'yes') { bump('taker_bought_no'); continue; }
  let started = false;
  for (const l of cls.legs) { const ko = kickoffOf(l.id.replace(/:.*/, '')); if (ko == null) { started = true; bump('no_kickoff'); break; } if (ko <= p.t) { started = true; bump('game_started'); break; } }
  if (started) continue;
  const src = sourceAt(p.t);
  const base = q.priceCombo(cls.legs.map((l) => ({ ...l })), src, { cfg: { margin: 0, guardrail: 'off', maxLegs: 40, minLegs: 2 } });
  if (!base.ok) { bump(`price:${base.reason}`); continue; }
  // lock price (needs own asks on every leg)
  const withLock = q.priceCombo(cls.legs.map((l) => ({ ...l })), src, { cfg: { margin: 0, guardrail: 'lock', maxLegs: 40, minLegs: 2 } });
  rows.push({
    p, legs: cls.legs, n: cls.legs.length, fair: base.fair, mid: base.fairMid, lock: withLock.ok ? base.yLock : null,
    tradeY: p.y, c: p.c,
  });
}
const totalPrints = prints.length;
console.log('=== NO-BOOST NFL ML COMBO QUOTER — BACKTEST (paper) ===');
console.log(`prints on all-NFL-ML combos in data: ${totalPrints}`);
console.log('excluded:', JSON.stringify(skip));
console.log(`priceable & pregame & taker-bought-YES prints tested: ${rows.length}`);

// ── 2. where does the traded price sit relative to fair / mid / lock? (American odds) ─
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }
function quantile(a, f) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; }
const buckets = [[2, 3], [4, 6], [7, 8], [9, 10], [11, 40]];
console.log('\n-- Traded price vs model, by leg count (American odds; ratio = traded price / model price, >1 = taker paid MORE than model) --');
console.log('legs | prints | median traded | median fair(inverse) | median fair(mid) | median lock | ratio vs inverse (p25/p50/p75) | ratio vs mid (p25/p50/p75) | ratio vs lock p50');
for (const [lo, hi] of buckets) {
  const r = rows.filter((x) => x.n >= lo && x.n <= hi);
  if (!r.length) continue;
  const ri = r.map((x) => x.tradeY / x.fair);
  const rm = r.filter((x) => x.mid).map((x) => x.tradeY / x.mid);
  const rl = r.filter((x) => x.lock).map((x) => x.tradeY / x.lock);
  const am = (arr) => fmt(q.americanFromProb(median(arr)));
  console.log(`${lo}-${hi} | ${r.length} | ${am(r.map((x) => x.tradeY))} | ${am(r.map((x) => x.fair))} | ${am(r.filter((x) => x.mid).map((x) => x.mid))} | ${am(r.filter((x) => x.lock).map((x) => x.lock))} | ${quantile(ri, .25).toFixed(2)}/${quantile(ri, .5).toFixed(2)}/${quantile(ri, .75).toFixed(2)} | ${rm.length ? `${quantile(rm, .25).toFixed(2)}/${quantile(rm, .5).toFixed(2)}/${quantile(rm, .75).toFixed(2)}` : 'n/a'} | ${rl.length ? quantile(rl, .5).toFixed(2) : 'n/a'}`);
}

// ── 3. margin sweep ─────────────────────────────────────────────────────────
function sweep(label, guardrail, maxLegs, fairKey = 'fair') {
  console.log(`\n-- Margin sweep [${fairKey === 'fair' ? 'fair = INVERSE method' : 'fair = MID of book (no-vig)'}]: guardrail=${guardrail} maxLegs=${maxLegs} (win = our YES price < traded YES price, 0.001 tick, rounded up) --`);
  console.log('margin | quoted | won | win rate | $ premium on wins | EV $ vs inverse-fair | EV $ vs mid-fair | EV $/fill vs mid | settled P&L $ (known games)');
  for (const m of MARGINS) {
    let quoted = 0; let won = 0; let prem = 0; let evInv = 0; let evMid = 0; let pnl = 0; let settledN = 0; let tie = 0;
    for (const r of rows) {
      if (r.n > maxLegs) continue;
      const cfg = { margin: m, guardrail, maxLegs, minLegs: 2, skew: 0 };
      if (fairKey === 'mid' && !r.mid) continue;
      const price = quoteFromRow(r, cfg, fairKey);
      if (price == null) continue;
      quoted += 1;
      const w = q.winsPrint(price, r.tradeY);
      if (w === 'tie') tie += 1;
      if (w !== 'win') continue;
      won += 1;
      prem += r.c * price;
      evInv += r.c * (price - r.fair);
      if (r.mid) evMid += r.c * (price - r.mid);
      const outcome = settle(r);
      if (outcome != null) { pnl += outcome === 'hit' ? r.c * (price - 1) : r.c * price; settledN += 1; }
    }
    console.log(`${(m * 100).toFixed(1)}% | ${quoted} | ${won} (+${tie} ties) | ${pct(won, quoted)} | ${money(prem)} | ${money(evInv)} | ${money(evMid)} | ${won ? money(evMid / won) : 'n/a'} | ${money(pnl)} (${settledN} settled)`);
  }
}
function quoteFromRow(r, cfg, fairKey = 'fair') {
  const target = q.targetPrice(r[fairKey], cfg.margin, 'price');
  let y = target;
  if (cfg.guardrail === 'lock') { if (r.lock == null) return null; y = Math.max(y, r.lock); }
  const tick = 0.001;
  return Math.round(q.ceilTo(y, tick) * 1e4) / 1e4;
}
const resCache = new Map();
function settle(r) {
  const k = r.p.k + '@' + r.p.t;
  if (resCache.has(k)) return resCache.get(k);
  let hit = true; let known = true;
  for (const l of r.p.legs) {
    const tk = `KXNFLGAME-2${l.split(':')[0]}`; const side = l.split(':')[1];
    const res = meta[tk] && meta[tk].res;
    if (res !== 'yes' && res !== 'no') { known = false; break; }
    if ((side === 'yes') !== (res === 'yes')) hit = false;
  }
  const out = known ? (hit ? 'hit' : 'miss') : null;
  resCache.set(k, out);
  return out;
}

sweep('A', 'lock', 10);
sweep('B', 'off', 10);
sweep('C', 'lock', 40);
sweep('D', 'off', 10, 'mid');
sweep('E', 'off', 8, 'mid');

// ── 4. margin that would win flow: required margin per print ────────────────
console.log('\n-- Required margin to win a print (guardrail OFF): m* = traded / inverse-fair − 1; share of tested prints with m* >= m --');
const mstar = rows.map((r) => r.tradeY / r.fair - 1);
for (const m of [-0.4, -0.3, -0.2, -0.1, 0, 0.05, 0.1, 0.15, 0.25]) {
  console.log(`  we could quote margin ${(m * 100).toFixed(0)}% and still win ${pct(mstar.filter((x) => x >= m).length, mstar.length)} of prints`);
}
console.log('-- Same, but margin measured against MID (no-vig book mid) fair — what our edge REALLY is --');
const mm = rows.filter((r) => r.mid).map((r) => r.tradeY / r.mid - 1);
for (const m of [-0.3, -0.2, -0.1, 0, 0.05, 0.1, 0.15, 0.25]) {
  console.log(`  true edge >= ${(m * 100).toFixed(0)}% vs mid on ${pct(mm.filter((x) => x >= m).length, mm.length)} of prints`);
}

// ── 5. exposure / caps needed: simulate fills at 10% (lock on), uncapped then capped ──
function simulate(label, cfgRisk, margin, guardrail, maxLegs) {
  let cur = 0;
  const risk = createRiskBook({ ...RISK_DEFAULTS, ...cfgRisk }, { now: () => cur });
  const events = [];
  rows.forEach((r, i) => { if (r.n <= maxLegs) events.push({ t: r.p.t, kind: 'print', i }); });
  const settleAt = new Map();
  const live = new Map();
  let wins = 0; let blocked = 0; const reasons = {}; let peakTotal = 0; let peakGame = 0; let peakSel = 0; let realized = 0; let evMid = 0; let evInv = 0; let prem = 0;
  const ev2 = events.sort((a, b) => a.t - b.t);
  const pending = [];
  const flushSettle = (upTo) => {
    pending.sort((a, b) => a.t - b.t);
    while (pending.length && pending[0].t <= upTo) {
      const s = pending.shift();
      const pnl = risk.settle(s.id, s.hit);
      if (pnl != null) realized += pnl;
    }
  };
  for (const e of ev2) {
    cur = e.t * 1000;
    flushSettle(e.t);
    const r = rows[e.i];
    const cfg = { margin, guardrail, maxLegs, minLegs: 2, skew: 0 };
    const price = quoteFromRow(r, cfg);
    if (price == null || q.winsPrint(price, r.tradeY) !== 'win') continue;
    const gl = r.legs.map((l) => ({ gameId: l.gameId, selection: l.team }));
    const chk = risk.check(gl, price, r.c);
    if (!chk.ok) { blocked += 1; reasons[chk.reason] = (reasons[chk.reason] || 0) + 1; continue; }
    const id = `${r.p.k}@${r.p.t}`;
    risk.addFill(id, gl, price, r.c);
    wins += 1; prem += r.c * price; evInv += r.c * (price - r.fair); if (r.mid) evMid += r.c * (price - r.mid);
    const out = settle(r);
    if (out != null) {
      const lastClose = Math.max(...r.p.legs.map((l) => Date.parse((meta[`KXNFLGAME-2${l.split(':')[0]}`] || {}).occ) / 1000 + 4 * 3600));
      pending.push({ t: lastClose, id, hit: out === 'hit' });
    }
    peakTotal = Math.max(peakTotal, risk.total());
    for (const v of risk._gameLoss.values()) peakGame = Math.max(peakGame, v);
    for (const v of risk._selLoss.values()) peakSel = Math.max(peakSel, v);
  }
  flushSettle(Infinity);
  console.log(`${label}: fills ${wins} | blocked ${blocked} ${JSON.stringify(reasons)} | premium ${money(prem)} | EV vs inverse ${money(evInv)} | EV vs mid ${money(evMid)} | realized settled P&L ${money(realized)} | peak max-loss: total ${money(peakTotal)}, game ${money(peakGame)}, selection ${money(peakSel)}`);
}
const INF = 1e12;
console.log('\n-- Exposure & caps (fills at margin 10%, lock guardrail ON, ≤10 legs; max-loss = contracts × (1 − price) of every OPEN combo) --');
simulate('uncapped      ', { maxComboLoss: INF, maxGameLoss: INF, maxSelectionLoss: INF, maxTotalLoss: INF, dailyLossLimit: 0 }, 0.10, 'lock', 10);
simulate('default caps  ', {}, 0.10, 'lock', 10);
simulate('tight caps    ', { maxComboLoss: 100, maxGameLoss: 400, maxSelectionLoss: 300, maxTotalLoss: 2000 }, 0.10, 'lock', 10);
console.log('-- Same at margin 0% / guardrail OFF (what flow actually looks like if we match the market) --');
simulate('uncapped m=0  ', { maxComboLoss: INF, maxGameLoss: INF, maxSelectionLoss: INF, maxTotalLoss: INF, dailyLossLimit: 0 }, 0, 'off', 10);
