// Phone-friendly Telegram FILL alert for the sniper. Pure formatter (tested in fill-alert.test.js).
// We SELL the taker's parlay: they buy YES at q, we hold NO at (1 − q). We win when any leg loses.
'use strict';
const { parseNcaafMl, teamName } = require('./ncaaf');
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

// "26OCT22NECHI" + one known team → "NE @ CHI" (Kalshi lists away then home).
function gameOf(code, team) {
  const teams = String(code || '').replace(/^\d{2}[A-Z]{3}\d{2}/, '');
  if (!team || !teams) return teams;
  if (teams.startsWith(team)) return `${team} @ ${teams.slice(team.length)}`;
  if (teams.endsWith(team)) return `${teams.slice(0, teams.length - team.length)} @ ${team}`;
  return teams;
}
function kickText(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).replace(',', '') + ' ET';
}
// KXNFLGAME-26OCT25CINBAL-CIN:yes → { bet: "CIN to win", game: "CIN @ BAL" }
// KXNFLTD-26OCT25CINBAL-BALDHENRY22-1:no → { bet: "Derrick Henry anytime TD (No)", game: "CIN @ BAL" }
function legParts(ticker, side, name) {
  const t = String(ticker || '').toUpperCase(); const parts = t.split('-'); const no = String(side || 'yes').toLowerCase() === 'no';
  if (t.startsWith('KXNFLTD')) {
    const code = parts[2] || '';
    let who = name ? String(name).split(':')[0].replace(/\s*(anytime|to score).*$/i, '').trim() : null;
    if (!who) { const m = /^[A-Z]{2,3}([A-Z])([A-Z]+?)\d*$/.exec(code); who = m ? `${m[1]}. ${title(m[2])}` : code; }
    const tm = gameOf(parts[1], code.slice(0, 3)).includes('@') ? code.slice(0, 3) : code.slice(0, 2);
    return { bet: `${who} anytime TD${no ? ' (No)' : ''}`, game: gameOf(parts[1], tm) };
  }
  if (t.startsWith('KXNCAAFGAME-')) {
    const g = parseNcaafMl(t);
    if (g) return { bet: `${teamName(g.selection)} to win${no ? ' (No)' : ''}`, game: `${teamName(g.codes[0])} @ ${teamName(g.codes[1])}` };
  }
  if (t.startsWith('KXNFLGAME')) {
    const pick = parts[2] || '';
    return { bet: `${pick} to win${no ? ' (No)' : ''}`, game: gameOf(parts[1], pick) };
  }
  return { bet: `${t}${no ? ' (No)' : ''}`, game: '' };
}
function legLabel(ticker, side, name) { const p = legParts(ticker, side, name); return p.game ? `${p.bet} · ${p.game}` : p.bet; }

// d: sniper decision (legDetail, legs, fairYes, quoteYes, roi); fill: contracts, cost, fee (actual).
function formatFillAlert({ d, contracts, cost, fee = 0, kickoffOf = () => null }) {
  const n = Number(contracts) || 0; const risk = (Number(cost) || 0) + (Number(fee) || 0);
  const toWin = n - risk; const q = n > 0 ? 1 - (Number(cost) || 0) / n : Number(d.quoteYes); // taker's YES price
  const fair = Number(d.fairYes);
  const ev = n * (1 - fair) - risk; const edge = risk > 0 ? ev / risk : null;
  const legs = (d.legDetail && d.legDetail.length ? d.legDetail : (d.legs || []).map((k) => { const [ticker, side] = String(k).split(':'); return { ticker, side }; }));
  const lines = ['🎯 SNIPER FILL (real money, not Combo Locks)', `We sold a ${legs.length}-leg parlay · ${n.toLocaleString('en-US', { maximumFractionDigits: 0 })} contracts`, ''];
  legs.forEach((l, i) => {
    const p = legParts(l.ticker, l.side, l.name); let ko = null; try { ko = kickText(kickoffOf(l.ticker)); } catch (_) { ko = null; }
    lines.push(`${i + 1}. ${p.bet}`);
    lines.push(`    ${[p.game, ko].filter(Boolean).join(' · ')}`);
    const bits = [`fair ${american(l.fair)}`];
    if (l.depthUsd != null) bits.push(`${usd0(l.depthUsd)} deep`);
    if (l.venue) bits.push(VENUE[String(l.venue).split(':')[0]] || l.venue);
    lines.push(`    ${bits.join(' · ')}`);
  });
  lines.push('', `Parlay fair: ${american(fair)}`, `We sold at: ${american(q)}`,
    `Risk: ${usd(risk)}  →  To win: ${usd(toWin)}`, `Edge: ${edge == null ? '—' : `${(edge * 100).toFixed(1)}%`}  (expected profit ${usd(ev)})`,
    '', 'We win if ANY leg misses.');
  return lines.join('\n');
}

module.exports = { formatFillAlert, legLabel, legParts, american };
