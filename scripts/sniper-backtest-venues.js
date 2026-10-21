// Backtest: Kalshi-only vs best-of-venues inverse fair, ML + anytime-TD legs.
// Export row: [rfq_id, ts, contracts, target_cost, traded_yes, n_legs, fair_kalshi, fair_all, legs[], series, best_venues]
// Fairs come from noboost pm_inverse_legs ($500 depth, live at RFQ time; only venues with real depth,
// i.e. reason 'ok'; top-of-book-only quotes excluded). Win = our min-ROI price < traded price.
'use strict';
const fs = require('fs');
const S = require('../auto-sniper');
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const which = process.argv[3] === 'kalshi' ? 6 : 7;
const tdOnly = process.argv[4] === 'td';
const SERIES_RATE = { KXMVECROSSCATEGORY0: 0, KXMVECROSSCATEGORY: 0.035 };
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const legDate = (t) => { const m = /-(\d\d)([A-Z]{3})(\d\d)/.exec(t); return m ? `20${m[1]}-${MON[m[2]]}-${m[3]}` : null; };
const config = S.sniperConfig({ SNIPER_ENABLED: '1', SNIPER_MIN_LEG_FAIR: '0', SNIPER_MAX_LEG_FAIR: '1' });
const ledger = S.createSniperLedger();
const o = { scanned: 0, withTd: 0, noFair: 0, wouldQuote: 0, fills: 0, tdFills: 0, risk: 0, ev: 0, payout: 0, capBinds: 0, skips: {}, peak: 0, q: [] };
for (const r of rows) {
  const [id, ts, c, tc, ty, nl, fk, fa, legsRaw, ser] = r;
  const hasTd = legsRaw.some((k) => k.startsWith('KXNFLTD'));
  if (tdOnly && !hasTd) continue;
  o.scanned++; if (hasTd) o.withTd++;
  const fair = r[which];
  if (fair == null) { o.noFair++; continue; }
  const nowMs = ts * 1000;
  const legs = legsRaw.map((k) => { const [t, side] = k.split(':'); return { ticker: t, side, date: legDate(t), fair_yes: Math.pow(fair, 1 / legsRaw.length) }; });
  const d = S.evaluateSnipe({ rfq_id: id, venue: 'kalshi', status: 'seen', legs, contracts: c, cash_size: c == null ? tc : null }, { config, ledger, nowMs, makerRate: SERIES_RATE[ser] != null ? SERIES_RATE[ser] : 0.035 });
  if (d.action !== 'quote') { o.skips[d.reason] = (o.skips[d.reason] || 0) + 1; if (d.reason === 'total_cap') o.capBinds++; continue; }
  o.wouldQuote++;
  if (!(d.quoteYes < Number(ty))) { ledger.positions.delete(d.rfqId); ledger.day.risk -= d.risk; ledger.hour.pop(); continue; }
  o.fills++; if (hasTd) o.tdFills++; o.risk += d.risk; o.ev += d.ev; o.payout += d.payout; o.q.push(d.quoteAmerican);
  o.peak = Math.max(o.peak, ledger.totals().total);
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
console.log(JSON.stringify({ fair: which === 6 ? 'kalshi' : 'all', scope: tdOnly ? 'td' : 'all', scanned: o.scanned, withTd: o.withTd, noFair: o.noFair, wouldQuote: o.wouldQuote, fills: o.fills, tdFills: o.tdFills, riskUsd: Math.round(o.risk), evUsd: Math.round(o.ev), payoutUsd: Math.round(o.payout), roi: o.fills ? +(o.ev / o.risk * 100).toFixed(2) : null, medQuote: med(o.q), peakOpen: Math.round(o.peak), capBinds: o.capBinds, skips: o.skips }));
