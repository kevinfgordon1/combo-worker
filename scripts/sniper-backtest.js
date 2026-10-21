// Offline backtest of auto-sniper against combo_sniper_traded exports.
// Usage: node scripts/sniper-backtest.js <export.json> [legsMin legsMax]
// Export row: [rfq_id, unix_ts, contracts, target_cost, traded_yes, n_legs, fair_prob, legs[]]
// Win model: we fill only if our min-ROI price is strictly below what the
// taker actually paid (traded_yes). Fills reserve exposure; losses free it.
'use strict';
const fs = require('fs');
const S = require('../auto-sniper');
const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let rows = Array.isArray(raw) && Array.isArray(raw[0]) ? raw : raw;
const lo = Number(process.argv[3] || 2); const hi = Number(process.argv[4] || 4);
const MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
function legDate(t) { const m = /-(\d\d)([A-Z]{3})(\d\d)/.exec(t); return m ? `20${m[1]}-${MON[m[2]]}-${m[3]}` : null; }
const env = { SNIPER_ENABLED: '1', SNIPER_MIN_LEG_FAIR: '0', SNIPER_MAX_LEG_FAIR: '1', ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('SNIPER_'))) };
const config = S.sniperConfig(env);
const ledger = S.createSniperLedger();
const out = { scanned: 0, inScope: 0, wouldQuote: 0, fills: 0, lostRace: 0, risk: 0, ev: 0, payout: 0, capBinds: 0, skips: {}, peakOpen: 0, roi: [], qAm: [] };
for (const r of rows) {
  const [id, ts, c, tc, ty, nl, fp, legsRaw] = r;
  out.scanned++;
  if (nl < lo || nl > hi) continue;
  const nowMs = ts * 1000;
  const etDay = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const legs = legsRaw.map((k) => { const [t, side] = k.split(':'); return { ticker: t, side, date: legDate(t), fair_yes: Math.pow(fp, 1 / legsRaw.length) }; });
  if (legs.some((l) => l.date && l.date < etDay)) { out.skips.started = (out.skips.started || 0) + 1; continue; }
  if (legs.some((l) => !/^KX(NFL|MLB)GAME-/.test(l.ticker))) { out.skips.not_ml_scope = (out.skips.not_ml_scope || 0) + 1; continue; }
  out.inScope++;
  const d = S.evaluateSnipe({ rfq_id: id, venue: 'kalshi', status: 'seen', legs, contracts: c, cash_size: c == null ? tc : null }, { config, ledger, nowMs });
  if (d.action !== 'quote') { out.skips[d.reason] = (out.skips[d.reason] || 0) + 1; if (d.reason === 'total_cap') out.capBinds++; continue; }
  out.wouldQuote++;
  if (!(d.quoteYes < Number(ty))) { // lost the race: release reservation
    out.lostRace++; ledger.positions.delete(d.rfqId); ledger.day.risk -= d.risk; ledger.hour.pop(); continue;
  }
  out.fills++; out.risk += d.risk; out.ev += d.ev; out.payout += d.payout; out.roi.push(d.roi); out.qAm.push(d.quoteAmerican);
  out.peakOpen = Math.max(out.peakOpen, ledger.totals().total);
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
console.log(JSON.stringify({ legs: `${lo}-${hi}`, scanned: out.scanned, inScope: out.inScope, wouldQuote: out.wouldQuote, fills: out.fills, lostRace: out.lostRace,
  riskUsd: Math.round(out.risk), evUsd: Math.round(out.ev), payoutUsd: Math.round(out.payout), avgRoi: out.fills ? +(out.ev / out.risk * 100).toFixed(2) : null,
  medianQuoteAmerican: med(out.qAm), peakOpenUsd: Math.round(out.peakOpen), totalCapBinds: out.capBinds, skips: out.skips }));
