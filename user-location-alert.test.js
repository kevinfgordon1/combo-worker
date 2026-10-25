'use strict';
const assert = require('assert');
const { createUserLocationAlert, isLocationAttestationFailure } = require('./user-location-alert');
function fakeClient() {
  const calls = [];
  const chain = (op) => { const c = { eq: () => c, is: () => c, then: (r) => Promise.resolve({ data: [], error: null }).then(r) }; calls.push(op); return c; };
  return { calls, from: () => ({ insert: (b) => { calls.push(['insert', b]); return Promise.resolve({ error: null }); }, update: () => chain('update'), select: () => chain('select') }) };
}
(async () => {
  assert(isLocationAttestationFailure('Kalshi create quote failed 403: Your location attestation for API trading is missing or expired. Please verify your location in the Kalshi app or website.'));
  assert(!isLocationAttestationFailure('insufficient_balance'));
  const c = fakeClient();
  const a = createUserLocationAlert({ client: c, log: () => {}, enabled: true });
  await a.onRejected('u1'); await a.onRejected('u1');
  assert.equal(c.calls.filter((x) => x[0] === 'insert').length, 1);
  assert.equal(c.calls[0][1].kind, 'location_expired');
  await a.onQuoted('u1'); await a.onQuoted('u1');
  assert.equal(c.calls.filter((x) => x === 'update').length, 1);
  const off = createUserLocationAlert({ client: c, log: () => {}, enabled: false });
  await off.onRejected('u2');
  assert.equal(c.calls.filter((x) => x[0] === 'insert').length, 1);
  console.log('user-location-alert ok');
})().catch((e) => { console.error(e); process.exit(1); });
