// Grade the Combo Sniper shadow tape after the games settle.
//
//   node scripts/sniper-shadow-grade.js --rows rows.json --trades trades.json --closes closes.json --results results.json
//
// With no --rows file, reads public.sniper_shadow_quotes (named columns, not
// select *) when SUPABASE_URL and SUPABASE_SERVICE_KEY are set. Closing
// inverse-bet fairs come from --closes or from public.sniper_leg_close
// (leg_key, fair_yes only). Public prints come from --trades. This script
// only reads.
//
// How to read a line. Prices are American odds (plus means the YES is the
// underdog). "would-fill" means a public print on that combo paid our YES
// price or more, so the taker would have taken us. "clv" is our YES quote
// minus the closing inverse-bet fair, in cents per $1 contract. Positive
// means we would have sold above the close. "pnl" is the settled dollars if
// that would-be fill had been ours: we hold NO, so a combo that loses pays
// us the YES premium minus the maker fee, and a combo that hits costs us the
// NO stake plus the fee. "open" means a leg has no result yet.
'use strict';
const fs = require('fs');
const { americanFromProb } = require('../engine');

const SHADOW_COLS = [
  'rfq_id', 'venue', 'market_ticker', 'seen_at', 'legs', 'fair_yes', 'fair_american',
  'min_edge_shadow', 'min_edge_live', 'quote_yes_shadow', 'quote_american_shadow',
  'quote_yes_live', 'quote_american_live', 'contracts', 'contracts_live',
  'fee_shadow', 'fee_live', 'filled', 'trade_yes', 'trade_american',
].join(',');

function fmtAm(a) {
  if (a == null || !Number.isFinite(Number(a))) return 'n/a';
  const n = Math.round(Number(a));
  return n > 0 ? `+${n}` : String(n);
}

function readJson(path) {
  if (!path) return null;
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function asList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return Object.entries(raw).map(([k, v]) => (v && typeof v === 'object' ? { ...v, key: k } : { key: k, value: v }));
}

// Taker paid our YES price or a worse one (higher YES).
function wouldTake(quoteYes, tradeYes) {
  const q = Number(quoteYes);
  const t = Number(tradeYes);
  return q > 0 && q < 1 && t > 0 && t < 1 && t + 1e-9 >= q;
}

function tradeYesOf(t) {
  if (!t) return null;
  const y = t.yes != null ? t.yes : (t.yes_price != null ? t.yes_price : t.trade_yes);
  const n = Number(y);
  return n > 0 && n < 1 ? n : null;
}

function tradeTs(t) {
  if (!t) return null;
  if (t.ts != null && Number.isFinite(Number(t.ts))) return Number(t.ts);
  const p = Date.parse(t.created_time || t.time || t.created_at || '');
  return Number.isFinite(p) ? p : null;
}

// One print per RFQ. Prefer an explicit rfq_id. Otherwise the earliest public
// print on the same combo ticker inside the window after we saw the RFQ.
function assignTrades(rows, trades, windowMs) {
  const used = new Set();
  const out = new Map();
  const sorted = [...(rows || [])].sort((a, b) => Date.parse(a.seen_at) - Date.parse(b.seen_at));
  for (const row of sorted) {
    const own = Number(row.trade_yes);
    if (own > 0 && own < 1) {
      out.set(row, { yes: own, ts: null, rfq_id: row.rfq_id });
      continue;
    }
    const id = String(row.rfq_id || '');
    const ticker = String(row.market_ticker || '').toUpperCase();
    const seen = Date.parse(row.seen_at);
    let hit = null;
    let hitTs = Infinity;
    for (let i = 0; i < (trades || []).length; i += 1) {
      if (used.has(i)) continue;
      const t = trades[i];
      const yes = tradeYesOf(t);
      if (yes == null) continue;
      const tid = t.rfq_id != null ? String(t.rfq_id) : '';
      if (tid && tid === id) { used.add(i); hit = { yes, ts: tradeTs(t), rfq_id: tid }; break; }
      if (!ticker || String(t.ticker || t.market_ticker || '').toUpperCase() !== ticker) continue;
      const ts = tradeTs(t);
      if (!Number.isFinite(seen) || !Number.isFinite(ts)) continue;
      if (ts < seen - 2000 || ts > seen + windowMs) continue;
      if (ts < hitTs) { hitTs = ts; hit = { yes, ts, rfq_id: null, index: i }; }
    }
    if (hit) {
      if (hit.index != null) used.add(hit.index);
      out.set(row, hit);
    }
  }
  return out;
}

function legKey(ticker, side) {
  return `${String(ticker || '').toUpperCase()}:${String(side || 'yes').toLowerCase()}`;
}

function closeMap(raw) {
  const m = new Map();
  for (const c of asList(raw)) {
    if (!c || typeof c !== 'object') continue;
    const fair = Number(c.fair_yes != null ? c.fair_yes : c.value);
    const rawKey = c.leg_key || c.key;
    if (!rawKey || !(fair > 0 && fair < 1)) continue;
    const parts = String(rawKey).split(':');
    m.set(legKey(parts[0], parts[1]), fair);
  }
  return m;
}

function resultMap(raw) {
  const m = new Map();
  for (const r of asList(raw)) {
    const ticker = String(r.ticker || r.market_ticker || r.key || '').toUpperCase();
    const res = String(r.result || r.value || '').toLowerCase();
    if (ticker && res) m.set(ticker, res);
  }
  return m;
}

// Product of the per-leg closing inverse-bet fairs. Null if any leg is missing.
function closeFairOf(row, closes) {
  const direct = Number(row && row.close_fair_yes);
  if (direct > 0 && direct < 1) return direct;
  const legs = (row && row.legs) || [];
  if (!legs.length) return null;
  let p = 1;
  for (const l of legs) {
    const f = closes.get(legKey(l.ticker, l.side));
    if (!(f > 0 && f < 1)) return null;
    p *= f;
  }
  return p > 0 && p < 1 ? p : null;
}

// Combo YES if every chosen side won. A market-level result, when present, wins.
function settledResult(row, results) {
  const market = results.get(String(row.market_ticker || '').toUpperCase());
  if (market === 'yes' || market === 'no' || market === 'void' || market === 'cancelled') return market === 'cancelled' ? 'void' : market;
  const legs = row.legs || [];
  if (!legs.length) return null;
  let hit = true;
  for (const l of legs) {
    const r = results.get(String(l.ticker || '').toUpperCase());
    if (!r) return null;
    if (r === 'void' || r === 'cancelled') return 'void';
    const side = String(l.side || 'yes').toLowerCase();
    const won = (side === 'yes' && r === 'yes') || (side === 'no' && r === 'no');
    if (!won) hit = false;
  }
  return hit ? 'yes' : 'no';
}

// Same settlement as sniper/live.js: we hold NO. cost = contracts * (1 - yes).
function makerPnl(quoteYes, contracts, fee, result) {
  if (result == null) return null;
  if (result === 'void') return 0;
  const n = Number(contracts);
  const q = Number(quoteYes);
  const f = Number(fee) || 0;
  if (!(n > 0) || !(q > 0 && q < 1)) return null;
  const cost = n * (1 - q);
  return (result === 'no' ? n : 0) - cost - f;
}

function levelOf(row, kind) {
  if (kind === 'live') {
    return {
      kind, edge: row.min_edge_live, quoteYes: row.quote_yes_live, quoteAmerican: row.quote_american_live,
      contracts: row.contracts_live, fee: row.fee_live,
    };
  }
  return {
    kind: 'shadow', edge: row.min_edge_shadow, quoteYes: row.quote_yes_shadow, quoteAmerican: row.quote_american_shadow,
    contracts: row.contracts, fee: row.fee_shadow,
  };
}

function gradeShadow(rows, { trades = [], closes = null, results = null, windowMs = 60000 } = {}) {
  const assigned = assignTrades(rows, trades, windowMs);
  const closeLookup = closes instanceof Map ? closes : closeMap(closes);
  const resultLookup = results instanceof Map ? results : resultMap(results);
  const levels = new Map();
  for (const row of rows || []) {
    const trade = assigned.get(row) || null;
    const closeFair = closeFairOf(row, closeLookup);
    const result = settledResult(row, resultLookup);
    for (const kind of ['shadow', 'live']) {
      const lv = levelOf(row, kind);
      if (!(lv.quoteYes > 0 && lv.quoteYes < 1)) continue;
      const key = `${kind}:${Number(lv.edge).toFixed(4)}`;
      if (!levels.has(key)) {
        levels.set(key, {
          kind, edge: lv.edge, wouldQuote: 0, filledBySomeone: 0, wouldFill: 0,
          settled: 0, pnl: 0, open: 0, fills: [],
        });
      }
      const bucket = levels.get(key);
      bucket.wouldQuote += 1;
      const took = trade ? wouldTake(lv.quoteYes, trade.yes) : false;
      if (trade) bucket.filledBySomeone += 1;
      if (!took) continue;
      bucket.wouldFill += 1;
      const pnl = makerPnl(lv.quoteYes, lv.contracts, lv.fee, result);
      if (pnl == null) bucket.open += 1;
      else { bucket.settled += 1; bucket.pnl += pnl; }
      const clvCents = closeFair != null ? (lv.quoteYes - closeFair) * 100 : null;
      bucket.fills.push({
        rfqId: row.rfq_id,
        venue: row.venue,
        quoteAmerican: lv.quoteAmerican != null ? lv.quoteAmerican : americanFromProb(lv.quoteYes),
        closeAmerican: americanFromProb(closeFair),
        tradeAmerican: americanFromProb(trade.yes),
        clvCents,
        pnl,
        result,
      });
    }
  }
  return {
    rows: (rows || []).length,
    windowMs,
    levels: [...levels.values()].sort((a, b) => a.edge - b.edge || (a.kind === 'shadow' ? -1 : 1)),
  };
}

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'open';
  const v = Number(n);
  const sign = v < 0 ? '-' : '+';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function formatGrade(report) {
  const lines = [
    `sniper shadow grade: ${report.rows} priced RFQ(s), trade window ${Math.round(report.windowMs / 1000)}s`,
    'Prices are American. clv is our YES quote minus the closing inverse-bet fair, in cents. Positive means we would have sold above the close.',
  ];
  if (!report.levels.length) {
    lines.push('No would-be quotes in this set.');
    return lines.join('\n');
  }
  for (const lv of report.levels) {
    const pct = (Number(lv.edge) * 100).toFixed(1).replace(/\.0$/, '');
    lines.push(
      `edge ${pct}% (${lv.kind})  would-quote ${lv.wouldQuote}  filled-by-someone ${lv.filledBySomeone}  would-fill ${lv.wouldFill}  settled ${lv.settled}${lv.open ? `  open ${lv.open}` : ''}  pnl ${money(lv.settled ? lv.pnl : (lv.wouldFill ? null : 0))}`
    );
    for (const f of lv.fills) {
      const clv = f.clvCents == null ? 'clv n/a' : `clv ${f.clvCents >= 0 ? '+' : ''}${f.clvCents.toFixed(1)}¢`;
      lines.push(
        `  ${f.rfqId} ${f.venue} quote ${fmtAm(f.quoteAmerican)}  close ${fmtAm(f.closeAmerican)}  trade ${fmtAm(f.tradeAmerican)}  ${clv}  pnl ${money(f.pnl)}`
      );
    }
  }
  return lines.join('\n');
}

async function loadRows(supabase, pageSize) {
  const rows = [];
  for (let from = 0; from < pageSize * 20; from += pageSize) {
    const { data, error } = await supabase.from('sniper_shadow_quotes').select(SHADOW_COLS).order('seen_at', { ascending: true }).range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const chunk = data || [];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
  }
  return rows;
}

async function loadCloses(supabase, rows) {
      const keys = [];
  const seen = new Set();
  for (const row of rows) {
    for (const l of row.legs || []) {
      const key = legKey(l.ticker, l.side);
      if (!seen.has(key)) { seen.add(key); keys.push(key); }
    }
  }
  const m = new Map();
  for (let i = 0; i < keys.length; i += 200) {
    const slice = keys.slice(i, i + 200);
    const { data, error } = await supabase.from('sniper_leg_close').select('leg_key,fair_yes').in('leg_key', slice);
    if (error) {
      if (/sniper_leg_close|does not exist|schema cache/i.test(error.message)) return m;
      throw new Error(error.message);
    }
    for (const r of data || []) {
      if (!r.leg_key || !(Number(r.fair_yes) > 0)) continue;
      const parts = String(r.leg_key).split(':');
      m.set(legKey(parts[0], parts[1]), Number(r.fair_yes));
    }
  }
  return m;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const windowMs = Number(arg('--window-ms')) > 0 ? Number(arg('--window-ms')) : 60000;
  const trades = asList(readJson(arg('--trades')));
  const results = readJson(arg('--results'));
  let rows = readJson(arg('--rows'));
  let closes = readJson(arg('--closes'));
  if (!rows) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      console.log('Pass --rows, or set SUPABASE_URL and SUPABASE_SERVICE_KEY to read sniper_shadow_quotes.');
      return;
    }
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    rows = await loadRows(supabase, 1000);
    if (!closes) closes = await loadCloses(supabase, rows);
  }
  const report = gradeShadow(rows || [], { trades, closes, results, windowMs });
  console.log(formatGrade(report));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message || String(e));
    process.exitCode = 1;
  });
}

module.exports = {
  gradeShadow, formatGrade, wouldTake, makerPnl, closeFairOf, settledResult, assignTrades, fmtAm, SHADOW_COLS,
};
