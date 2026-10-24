// Phone-friendly Telegram FILL alert for the sniper. Pure formatter (tested in fill-alert.test.js).
// We SELL the taker's parlay: they buy YES at q, we hold NO at (1 − q). We win when any leg loses.
'use strict';
const { parseNcaafMl, teamName } = require('./ncaaf');
const { parseLineTicker } = require('./lines');
const NBA = require('./nba');
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
const NICK = { ARI: 'Cardinals', ATL: 'Falcons', BAL: 'Ravens', BUF: 'Bills', CAR: 'Panthers', CHI: 'Bears', CIN: 'Bengals', CLE: 'Browns', DAL: 'Cowboys', DEN: 'Broncos', DET: 'Lions', GB: 'Packers', HOU: 'Texans', IND: 'Colts', JAC: 'Jaguars', JAX: 'Jaguars', KC: 'Chiefs', LV: 'Raiders', LAC: 'Chargers', LAR: 'Rams', LA: 'Rams', MIA: 'Dolphins', MIN: 'Vikings', NE: 'Patriots', NO: 'Saints', NYG: 'Giants', NYJ: 'Jets', PHI: 'Eagles', PIT: 'Steelers', SF: '49ers', SEA: 'Seahawks', TB: 'Buccaneers', TEN: 'Titans', WAS: 'Commanders', WSH: 'Commanders' };
const ptsTxt = (x) => { const v = Math.round(Number(x) * 10) / 10; return `${v}`; };
// Spread / total legs (strike from the ticker = Kalshi floor_strike: GB8 => "wins by over 7.5").
//   KXNFLSPREAD-26OCT25NYGHOU-HOU11:no => "Texans -10.5 — No (Giants +10.5)", opp "HOU -10.5"
//   KXNFLTOTAL-26OCT26DALPHI-45:no     => "DAL @ PHI Over/Under 44.5 — Under", opp "Over 44.5"
function lineParts(t, no) {
  const g = parseLineTicker(t); if (!g) return null;
  const nfl = g.league === 'nfl'; const nba = g.league === 'nba';
  const blob = String(t.split('-')[1] || '').replace(/^\d{2}[A-Z]{3}\d{2}(\d{4})?/, '');
  const up = (c) => String(c).toUpperCase();
  // Kalshi lists away then home; codes normalised (e.g. jax/jac) may not appear verbatim => keep order.
  const ix = (c) => { const i = blob.indexOf(up(c)); return i < 0 ? 99 : i; };
  const [away, home] = [...g.teams].map(up).sort((a, b) => ix(a) - ix(b));
  g.sel = up(g.sel);
  const nm = (c) => (nfl ? (NICK[c] || c) : nba ? NBA.nickName(c) : teamName(c));
  const game = nfl || nba ? `${away} @ ${home}` : `${teamName(away)} @ ${teamName(home)}`;
  const L = ptsTxt(g.line);
  if (g.market === 'total') {
    return { bet: `${game} Over/Under ${L} — ${no ? 'Under' : 'Over'}`, game, opp: `${no ? 'Over' : 'Under'} ${L}` };
  }
  const opp = [away, home].find((x) => x !== g.sel);
  const short = (c) => (nfl || nba ? c : teamName(c));
  return {
    bet: no ? `${nm(g.sel)} -${L} — No (${nm(opp)} +${L})` : `${nm(g.sel)} -${L}`,
    game, opp: no ? `${short(g.sel)} -${L}` : `${short(opp)} +${L}`,
  };
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
    return { bet: `${who} anytime TD${no ? ' (No)' : ''}`, game: gameOf(parts[1], tm), opp: no ? 'TD Yes' : 'No TD' };
  }
  if (t.startsWith('KXNCAAFGAME-')) {
    const g = parseNcaafMl(t);
    if (g) { const other = g.codes.find((c) => c !== g.selection); return { bet: `${teamName(g.selection)} to win${no ? ' (No)' : ''}`, game: `${teamName(g.codes[0])} @ ${teamName(g.codes[1])}`, opp: no ? teamName(g.selection) : (other ? teamName(other) : null) }; }
  }
  if (t.startsWith('KXNBAGAME-')) { // KXNBAGAME-26OCT23DALIND-IND:yes → "Pacers to win" · "DAL @ IND", opp "DAL"
    const g = NBA.parseNbaMl(t);
    if (g) { const other = g.codes.find((c) => c !== g.selection); return { bet: `${NBA.nickName(g.selection)} to win${no ? ' (No)' : ''}`, game: `${g.codes[0]} @ ${g.codes[1]}`, opp: no ? g.selection : other }; }
  }
  if (/^KX(NFL|NCAAF|NBA)(SPREAD|TOTAL)-/.test(t)) { const lp = lineParts(t, no); if (lp) return lp; }
  if (t.startsWith('KXNFLGAME')) {
    const pick = parts[2] || '';
    const game = gameOf(parts[1], pick); const other = game.includes(' @ ') ? game.split(' @ ').find((x) => x !== pick) : null;
    return { bet: `${pick} to win${no ? ' (No)' : ''}`, game, opp: no ? pick : other };
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
    // fair = 1 − (best opposing cost incl. that venue's fee), so the opposing price is exactly 1 − fair.
    if (Number(l.fair) > 0 && Number(l.fair) < 1) bits.push(`from opp ${p.opp ? `${p.opp} ` : ''}${american(1 - Number(l.fair))}`);
    if (l.depthUsd != null) bits.push(`${usd0(l.depthUsd)} deep (to win)`);
    if (l.venue) bits.push(VENUE[String(l.venue).split(':')[0]] || l.venue);
    lines.push(`    ${bits.join(' · ')}`);
  });
  lines.push('', `Parlay fair: ${american(fair)}`, `We sold at: ${american(q)}`,
    `Risk: ${usd(risk)}  →  To win: ${usd(toWin)}`, `Edge: ${edge == null ? '—' : `${(edge * 100).toFixed(1)}%`}  (expected profit ${usd(ev)})`,
    '', 'We win if ANY leg misses.');
  return lines.join('\n');
}

module.exports = { formatFillAlert, legLabel, legParts, american };
