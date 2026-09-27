'use strict';
const assert = require('assert');
const {
  createWsStatusAlerter,
  formatWsAlert,
  isHandshakeOrAuth,
  isSubscriptionLost,
  isFailedReconnect,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_BURST_COUNT,
  DEFAULT_DOWN_MS,
} = require('./ws-status-alert');

assert.strictEqual(DEFAULT_COOLDOWN_MS, 5 * 60_000);
assert.strictEqual(DEFAULT_BURST_COUNT, 3);
assert.strictEqual(DEFAULT_DOWN_MS, 10_000);
assert.strictEqual(isFailedReconnect('reconnecting', { reason: 'channel_error' }), false);
assert.strictEqual(isFailedReconnect('reconnecting', { reason: 'close_1006' }), true);

assert.strictEqual(isHandshakeOrAuth('error', { message: 'handshake 401: header_timestamp_expired' }), true);
assert.strictEqual(isHandshakeOrAuth('reconnecting', { reason: 'auth_timestamp' }), true);
assert.strictEqual(isHandshakeOrAuth('stalled', { age: 20000, stallMs: 20000 }), false);
assert.strictEqual(isHandshakeOrAuth('reconnecting', { reason: 'stall' }), false);
assert.strictEqual(isHandshakeOrAuth('subscribed'), false);
assert.strictEqual(isHandshakeOrAuth('unsubscribed', { message: 'unsubscribed' }), false);
assert.strictEqual(isSubscriptionLost('unsubscribed', { message: 'unsubscribed', type: 'unsubscribed' }), true);
assert.strictEqual(isSubscriptionLost('reconnecting', { wait: 1000, reason: 'unsubscribed' }), true);
assert.strictEqual(isSubscriptionLost('reconnecting', { wait: 1000, reason: 'channel_error' }), true);
assert.strictEqual(isSubscriptionLost('error', { message: 'unsubscribed', type: 'unsubscribed' }), true);
assert.strictEqual(isSubscriptionLost('error', { message: 'Channel error', code: 10 }), true);
assert.strictEqual(isSubscriptionLost('reconnecting', { reason: 'stall' }), false);
assert.strictEqual(isSubscriptionLost('error', { message: 'Unable to process message', code: 1 }), false);

{
  let t = 1_000_000;
  const alerter = createWsStatusAlerter({ now: () => t, cooldownMs: 60_000, burstCount: 3, burstWindowMs: 120_000 });
  assert.strictEqual(alerter.shouldAlert('stalled', { age: 20000 }), false, 'first quiet-book stall must not page');
  t += 20_000;
  assert.strictEqual(alerter.shouldAlert('stalled', { age: 21000 }), false, 'second stall must not page');
  t += 20_000;
  assert.strictEqual(alerter.shouldAlert('stalled', { age: 22000 }), true, 'stall burst must page once');
  t += 20_000;
  assert.strictEqual(alerter.shouldAlert('stalled', { age: 23000 }), false, 'cooldown must suppress further stall pages');
}

{
  let t = 2_000_000;
  const alerter = createWsStatusAlerter({ now: () => t, cooldownMs: 60_000, burstCount: 3, burstWindowMs: 120_000 });
  assert.strictEqual(
    alerter.shouldAlert('error', { message: 'handshake 401: header_timestamp_expired' }),
    true,
    'handshake/auth must page immediately'
  );
  t += 1_000;
  assert.strictEqual(
    alerter.shouldAlert('error', { message: 'handshake 401: header_timestamp_expired' }),
    false,
    'handshake pages honor cooldown'
  );
}

{
  let t = 3_000_000;
  const alerter = createWsStatusAlerter({ now: () => t, cooldownMs: 60_000, burstCount: 3, burstWindowMs: 120_000 });
  assert.strictEqual(alerter.shouldAlert('reconnecting', { wait: 1000, reason: 'stall' }), false);
  assert.strictEqual(alerter.shouldAlert('reconnecting', { wait: 1000, reason: 'close_1006' }), false);
  t += 5_000;
  assert.strictEqual(alerter.shouldAlert('reconnecting', { wait: 2000, reason: 'close_1006' }), false);
  t += 5_000;
  assert.strictEqual(
    alerter.shouldAlert('reconnecting', { wait: 4000, reason: 'close_1006' }),
    true,
    'repeated failed reconnects (not stall) must page'
  );
}

{
  let t = 4_000_000;
  const alerter = createWsStatusAlerter({ now: () => t, cooldownMs: 1_000, burstCount: 3, burstWindowMs: 30_000 });
  alerter.shouldAlert('stalled', {});
  t += 5_000;
  alerter.shouldAlert('stalled', {});
  t += 5_000;
  assert.strictEqual(alerter.shouldAlert('stalled', {}), true);
  t += 40_000;
  assert.strictEqual(alerter.shouldAlert('stalled', {}), false, 'isolated stall after burst window must not page');
}

{
  const text = formatWsAlert('stalled', { age: 23545, stallMs: 20000 });
  assert.match(text, /Kalshi WS stalled/);
  assert.match(text, /23545/);
  assert.match(text, /Repeated firehose stalls/);
  assert.ok(!/quoting is paused until communications resume/.test(text));
}

{
  const text = formatWsAlert('error', { message: 'handshake 401: expired' });
  assert.match(text, /quoting is paused until communications resume/);
}

{
  let t = 5_000_000;
  const alerter = createWsStatusAlerter({ now: () => t, cooldownMs: 60_000, burstCount: 3, burstWindowMs: 120_000, downMs: 10_000 });
  assert.strictEqual(
    alerter.shouldAlert('unsubscribed', { message: 'unsubscribed', type: 'unsubscribed' }),
    false,
    'a 1s unsubscribed reconnect must not page'
  );
  t += 1_000;
  assert.strictEqual(alerter.shouldAlert('subscribed', {}), false);
  t += 20_000;
  assert.strictEqual(alerter.poll(), null, 'recovery before 10s must not page');
}

{
  let t = 6_000_000;
  const alerter = createWsStatusAlerter({ now: () => t, cooldownMs: 60_000, burstCount: 3, burstWindowMs: 120_000, downMs: 10_000 });
  assert.strictEqual(
    alerter.shouldAlert('error', { message: 'unsubscribed', type: 'unsubscribed' }),
    false,
    'legacy quiet error { type: unsubscribed } must not page on the blip'
  );
  t += 11_000;
  const hit = alerter.poll();
  assert.ok(hit && hit.s === 'down', 'still down after 10s must page');
  assert.strictEqual(alerter.poll(), null, 'cooldown suppresses a second sustained page');
}

{
  let t = 7_000_000;
  const alerter = createWsStatusAlerter({ now: () => t, cooldownMs: 60_000, burstCount: 3, burstWindowMs: 120_000, downMs: 10_000 });
  const overflow = { message: 'Subscription buffer overflow', type: 'error', code: 25, shardKey: 3 };
  assert.strictEqual(alerter.shouldAlert('error', overflow), false, 'code 25 must not page immediately');
  t += 500;
  assert.strictEqual(
    alerter.shouldAlert('reconnecting', { wait: 1000, reason: 'channel_error', shardKey: 3 }),
    false
  );
  t += 9_000;
  assert.strictEqual(alerter.poll({ shardFactor: 8, shardsUp: 7 }), null, '9s is under the 10s bar');
  t += 1_000;
  const hit = alerter.poll({ shardFactor: 8, shardsUp: 7 });
  assert.ok(hit, 'code 25 socket still down at 10s must page');
  const text = formatWsAlert(hit.s, hit.info);
  assert.match(text, /Shard 3 still down/);
  assert.match(text, /quoting continues on 7\/8 sockets/);
  assert.ok(!/quoting is paused until communications resume/.test(text));
}

{
  let t = 8_000_000;
  const alerter = createWsStatusAlerter({ now: () => t, cooldownMs: 60_000, downMs: 10_000 });
  alerter.shouldAlert('error', { message: 'Subscription buffer overflow', code: 25 });
  t += 11_000;
  const hit = alerter.poll({ shardFactor: 1, shardsUp: 0 });
  assert.ok(hit);
  const text = formatWsAlert(hit.s, hit.info);
  assert.match(text, /quoting is paused until communications resume/);
}

{
  let t = 9_000_000;
  const alerter = createWsStatusAlerter({ now: () => t, cooldownMs: 60_000, downMs: 10_000 });
  alerter.shouldAlert('reconnecting', { reason: 'channel_error', shardKey: 1 });
  t += 400;
  assert.strictEqual(alerter.shouldAlert('subscribed', { shardKey: 1 }), false);
  t += 30_000;
  assert.strictEqual(alerter.poll(), null, 'shard that resubscribed must not page');
  alerter.shouldAlert('shard-retired', { shardKey: 2 });
}

{
  const text = formatWsAlert('unsubscribed', { message: 'unsubscribed', type: 'unsubscribed' });
  assert.match(text, /Kalshi WS unsubscribed/);
  assert.match(text, /Communications channel dropped/);
  assert.ok(!/quoting is paused until communications resume/.test(text));
}

console.log('ws-status-alert.test.js ok');
