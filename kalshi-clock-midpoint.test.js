'use strict';
// KALSHI_CLOCK_MIDPOINT=1: RTT-midpoint offset, lag/RTT gates, clamp, keep last good.
const assert = require('assert');
const auth = require('./kalshi-auth');
const { applyServerDateSample, resetClockOffset, clockOffset, clockMidpointEnabled, takeClockStats } = auth;

const dateAt = (ms) => new Date(Math.floor(ms / 1000) * 1000).toUTCString();

assert.strictEqual(clockMidpointEnabled({}), false, 'default off');
assert.strictEqual(clockMidpointEnabled({ KALSHI_CLOCK_MIDPOINT: '1' }), true);

// In-sync clock: Date within the noise band -> 0.
resetClockOffset();
let t = 1_760_000_000_200;
let r = applyServerDateSample(dateAt(t + 50), { sentAt: t, recvAt: t + 100, loopLagMs: 0 });
assert.ok(r.accepted); assert.strictEqual(clockOffset(), 0);

// Kenny's case: response handled seconds late (loop lag) -> rejected, offset unchanged.
resetClockOffset();
r = applyServerDateSample(dateAt(t - 7900), { sentAt: t - 8000, recvAt: t, loopLagMs: 0 });
assert.strictEqual(r.accepted, false); assert.strictEqual(r.reason, 'rtt'); assert.strictEqual(clockOffset(), 0);
r = applyServerDateSample(dateAt(t - 5000), { sentAt: t - 100, recvAt: t, loopLagMs: 4000 });
assert.strictEqual(r.accepted, false); assert.strictEqual(r.reason, 'lag'); assert.strictEqual(clockOffset(), 0);

// Real skew (+5s): first sample clamps to +1s, repeated samples walk to the target.
resetClockOffset();
const skew = 5000;
for (let i = 0; i < 4; i++) {
  r = applyServerDateSample(dateAt(t + skew + 100), { sentAt: t, recvAt: t + 200, loopLagMs: 0 });
  assert.strictEqual(r.reason, 'clamped');
}
assert.strictEqual(clockOffset(), 4000);
for (let i = 0; i < 3 && r.reason !== 'ok'; i++) r = applyServerDateSample(dateAt(t + skew + 100), { sentAt: t, recvAt: t + 200, loopLagMs: 0 });
assert.strictEqual(r.reason, 'ok');
assert.ok(Math.abs(clockOffset() - skew) <= 1000, `offset ${clockOffset()} ~ ${skew}`);
const good = clockOffset();

// Bad sample after a good one keeps the last good value.
r = applyServerDateSample('not a date', { sentAt: t, recvAt: t + 10, loopLagMs: 0 });
assert.strictEqual(r.accepted, false); assert.strictEqual(clockOffset(), good);
r = applyServerDateSample(dateAt(t - 9000), { sentAt: t, recvAt: t + 1500, loopLagMs: 0 });
assert.strictEqual(r.accepted, false); assert.strictEqual(clockOffset(), good);

const st = takeClockStats();
assert.ok(st.rejectedRtt >= 2 && st.rejectedLag >= 1 && st.clamped >= 4 && st.invalid >= 1);

// signedRequest uses the midpoint path when the switch is on: a slow (2s) response
// carrying a stale Date must not move the offset.
(async () => {
  resetClockOffset();
  process.env.KALSHI_CLOCK_MIDPOINT = '1';
  const res = await auth.signedRequest(async () => {
    await new Promise((ok) => setTimeout(ok, 1100));
    return { statusCode: 200, headers: { date: dateAt(Date.now() - 6000) }, text: '{}' };
  }, { keyId: 'k', pem: require('crypto').generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), method: 'GET', signPath: '/trade-api/v2/x' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(clockOffset(), 0, 'slow response Date ignored');
  delete process.env.KALSHI_CLOCK_MIDPOINT;
  console.log('kalshi-clock-midpoint ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
