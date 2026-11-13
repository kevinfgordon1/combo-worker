// Shared Kalshi series terms, with Polymarket combos explicitly outside this venue.
'use strict';
const core = require('./kalshi-fee-core');
const { isPolyComboTicker } = require('./poly-combo-classifier');
function createSeriesFeeCache(opts) {
  const cache = core.createSeriesFeeCache(opts);
  const kalshiMakerRate = cache.rateForTicker;
  cache.rateForTicker = ticker => isPolyComboTicker(ticker) ? 0 : kalshiMakerRate(ticker);
  return cache;
}
module.exports = { ...core, isPolyComboTicker, createSeriesFeeCache };
