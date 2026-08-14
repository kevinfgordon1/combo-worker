'use strict';
const { fillView } = require('./engine');
const { shortId } = require('./short-id');

const CENT = 0.01;

function collectionPrefix(collection) {
  return String(collection || '').trim().toUpperCase().replace(/-[RS]$/i, '');
}

// ticker.includes(collection), ticker.startsWith(collection), or the same after
// stripping a trailing -R / -S on the stored collection (Kalshi series suffix).
function tickerMatchesCollection(ticker, collection) {
  if (!ticker || !collection) return false;
  const t = String(ticker).toUpperCase();
  const c = String(collection).trim().toUpperCase();
  if (!c) return false;
  if (t.includes(c) || t.startsWith(c)) return true;
  const prefix = collectionPrefix(c);
  if (prefix && prefix !== c && (t.includes(prefix) || t.startsWith(prefix))) return true;
  return false;
}

function noBidMatchesFill(fillNoPrice, fillAmerican) {
  if (fillNoPrice == null || fillAmerican == null || fillAmerican === '') return false;
  const quoted = parseFloat(fillView(fillAmerican).noBid);
  const actual = Number(fillNoPrice);
  if (!Number.isFinite(quoted) || !Number.isFinite(actual)) return false;
  return Math.abs(actual - quoted) <= CENT + 1e-9;
}

// Best-effort only. Never guess when more than one parlay still fits.
function attributeParlay(ticker, fill, parlays) {
  if (!Array.isArray(parlays) || !parlays.length) return null;
  const collectionHits = parlays.filter((p) => tickerMatchesCollection(ticker, p.mve_collection));
  if (collectionHits.length === 1) return collectionHits[0];

  const pool = collectionHits.length > 1 ? collectionHits : parlays;
  const priceHits = pool.filter((p) => p.active && noBidMatchesFill(fill && fill.no_price, p.fill_american));
  if (priceHits.length === 1) return priceHits[0];
  return null;
}

function sumFillCounts(rows) {
  if (!Array.isArray(rows)) return null;
  let sum = 0;
  for (const r of rows) {
    const n = Number(r && r.count);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

function remainingContracts(maxContracts, filled) {
  if (filled == null || maxContracts == null || maxContracts === '') return null;
  const max = Number(maxContracts);
  const have = Number(filled);
  if (!(max > 0) || !Number.isFinite(have)) return null;
  return Math.max(0, max - have);
}

function formatQty(n) {
  if (n == null || n === '') return '?';
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return String(x);
}

function formatRealFillAlert({ parlay, row, filled = null }) {
  const price = row.no_price ?? row.yes_price ?? '?';
  const fillRef = shortId(row.fill_id);

  if (!parlay) {
    return (
      `💰 REAL FILL (from Kalshi account) — ${row.ticker}\n` +
      `${row.action || ''} ${row.count} contracts · ${row.outcome_side || ''} @ $${price}\n` +
      `unattributed combo fill · fill ${fillRef}`
    );
  }

  const side = row.outcome_side ? String(row.outcome_side).toUpperCase() : '';
  const mid = [row.action || '', formatQty(row.count), side].filter(Boolean).join(' ');
  const left = remainingContracts(parlay.max_contracts, filled);
  const sessionLine = left != null
    ? `session ${formatQty(filled)}/${formatQty(parlay.max_contracts)} · ${formatQty(left)} left · fill ${fillRef}`
    : `fill ${fillRef}`;

  return `💰 REAL FILL — ${parlay.label}\n${mid} @ $${price}\n${sessionLine}`;
}

module.exports = {
  tickerMatchesCollection,
  attributeParlay,
  sumFillCounts,
  remainingContracts,
  formatRealFillAlert,
  noBidMatchesFill,
};
