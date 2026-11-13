// Shared Kalshi series terms. Polymarket combos and Novig RFQ parlays are
// outside that schedule: both maker fees are 0.
'use strict';
const core = require('./kalshi-fee-core');
const { isPolyComboTicker } = require('./poly-combo-classifier');

function isNovigRfqTicker(ticker) {
  const t = String(ticker || '').trim().toLowerCase();
  return t === 'novig' || t.startsWith('novig:');
}

function createSeriesFeeCache(opts) {
  const cache = core.createSeriesFeeCache(opts);
  const kalshiMakerRate = cache.rateForTicker;
  cache.rateForTicker = (ticker) => (
    isPolyComboTicker(ticker) || isNovigRfqTicker(ticker) ? 0 : kalshiMakerRate(ticker)
  );
  return cache;
}

// Novig RFQ maker fee is $0 regardless of the Kalshi series on the lock.
function makerRateForVenue(venue, ticker, cache) {
  if (String(venue || '').trim().toLowerCase() === 'novig') return 0;
  if (!cache || typeof cache.rateForTicker !== 'function') return null;
  return cache.rateForTicker(ticker);
}

module.exports = {
  ...core,
  isPolyComboTicker,
  isNovigRfqTicker,
  makerRateForVenue,
  createSeriesFeeCache,
};
