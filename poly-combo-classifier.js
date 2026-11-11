'use strict';
const isPolyComboTicker = ticker => /^(caoc|crossd)-/i.test(String(ticker || '').trim());
module.exports = { isPolyComboTicker };
