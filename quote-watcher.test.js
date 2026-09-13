'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { shouldOpenQuoteWatcherWs } = require('./kalshi-ws');

assert.strictEqual(shouldOpenQuoteWatcherWs({}), true, 'local quote-watcher may open WS when no owner is set');
assert.strictEqual(shouldOpenQuoteWatcherWs({ QUOTE_WATCHER_WS: '0' }), false);
assert.strictEqual(shouldOpenQuoteWatcherWs({ KALSHI_WS_OWNER: 'combo' }), false);

const src = fs.readFileSync(path.join(__dirname, 'quote-watcher.js'), 'utf8');
assert.ok(/shouldOpenQuoteWatcherWs/.test(src), 'quote-watcher must consult the single-subscriber guard');
assert.ok(/QUOTE_WATCHER_WS/.test(src) && /KALSHI_WS_OWNER/.test(src));
assert.ok(/communications WS disabled/.test(src), 'disabled path must log that combo-worker keeps the socket');
assert.ok(/ONE subscription per API key/.test(src), 'start path must warn before opening a second communications WS');
assert.ok(/require\.main === module/.test(src), 'requiring quote-watcher must not auto-start a WS');
assert.ok(
  /if \(!shouldOpenQuoteWatcherWs\(\)\)/.test(src) && !/client\.start\(\)/.test(src.split('if (!shouldOpenQuoteWatcherWs())')[0]),
  'client.start must sit behind the WS owner guard'
);

console.log('quote-watcher.test.js ok');
