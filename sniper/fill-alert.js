// Phone-friendly Telegram FILL alert for the sniper. Pure formatter (tested in fill-alert.test.js).
// We SELL the taker's parlay: they buy YES at q, we hold NO at (1 − q). We win when any leg loses.
'use strict';
const VENUE = { kalshi: 'Kalshi', polymarket: 'Polymarket', novig: 'Novig', prophetx: 'ProphetX' };
function american(p) {
  const x = Number(p);
  if (!(x > 0 && x < 1)) return '—';
  const a = x >= 0.5 ? -Math.round((x / (1 - x)) * 100) : Math.round(((1 - x) / x) * 100);
  return a > 0 ? `+${a}` : `${a}`;
}
const usd = (x) => `$${Number(x || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usd0 = (x) => `$${Math.round(Number(x) || 0).toLocaleString('en-US')}`;
const title = (s) => s.charAt(0) + s.slice(1).toLowerCase();

// KXNFLGAME-26OCT25CINBAL-CIN:yes → "CIN to beat BAL · Moneyline · Yes"
// KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:no → "D. Henry (BAL) · Anytime TD · No"
function legLabel(ticker, side, name) {
  const t = String(ticker || '').toUpperCase(); const parts = t.split('-'); const s = String(side || 'yes').toLowerCase() === 'no' ? 'No' : 'Yes';
  if (t.startsWith('KXNFLTD-')) {
    const code = parts[2] || ''; const team = code.slice(0, 3);
    let who = name ? String(name).split(':')[0].trim() : null;
    if (!who) { const m = /^[A-Z]{2,3}([A-Z])([A-Z]+?)\d*$/.exec(code); who = m ? `${m[1]}. ${title(m[2])}` : code; }
    return `${who} (${team}) · Anytime TD · ${s}`;
  }
  if (t.startsWith('KXNFLGAME-')) {
    const pick = parts[2] || ''; const teams = (parts[1] || '').replace(/^\d{2}[A-Z]{3}\d{2}/, '');
    const opp = teams.startsWith(pick) ? teams.slice(pick.length) : teams.endsWith(pick) ? teams.slice(0, teams.length - pick.length) : '';
    return `${pick}${opp ? ` to beat ${opp}` : ' to win'} · Moneyline · ${s}`;
  }
  return `${t} · ${s}`;
}

// d: sniper decision (legDetail, legs, fairYes, quoteYes, roi); fill: contracts, cost, fee (actual).
function formatFillAlert({ d, rfq = {}, contracts, cost, fee = 0 }) {
  const n = Number(contracts) || 0; const risk = (Number(cost) || 0) + (Number(fee) || 0);
  const toWin = n - risk; const q = n > 0 ? 1 - (Number(cost) || 0) / n : Number(d.quoteYes); // taker's YES price
  const fair = Number(d.fairYes);
  const ev = n * (1 - fair) - risk; const edge = risk > 0 ? ev / risk : null;
  const legs = (d.legDetail && d.legDetail.length ? d.legDetail : (d.legs || []).map((k) => { const [ticker, side] = String(k).split(':'); return { ticker, side }; }));
  const lines = [`🎯 SNIPER (not Combo Locks) — FILL · real money`, `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} contracts · ${legs.length}-leg parlay`, ''];
  legs.forEach((l, i) => {
    lines.push(`${i + 1}. ${legLabel(l.ticker, l.side, l.name)}`);
    const bits = [`fair ${american(l.fair)}`];
    if (l.depthUsd != null) bits.push(`${usd0(l.depthUsd)} deep`);
    if (l.venue) bits.push(VENUE[String(l.venue).split(':')[0]] || l.venue);
    lines.push(`    ${bits.join(' · ')}`);
  });
  lines.push('', `Parlay fair: ${american(fair)}`, `Sold at: ${american(q)}  (we hold No at ${american(1 - q)})`,
    `Risk: ${usd(risk)}  →  To win: ${usd(toWin)}`, `Edge: ${edge == null ? '—' : `${(edge * 100).toFixed(1)}%`}  (EV ${usd(ev)})`);
  if (rfq.marketTicker) lines.push('', rfq.marketTicker);
  return lines.join('\n');
}

module.exports = { formatFillAlert, legLabel, american };
