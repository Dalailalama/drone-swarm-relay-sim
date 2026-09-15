// Finding #21 (review of ffb35e6, B12): the onboard grant check measured
// time since ANY C2 message — a broadcast without a new order refreshed
// lastC2 and kept an old grant alive indefinitely. The order must carry an
// ABSOLUTE grant expiry, enforced onboard independently of link freshness.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const RFD = R.RADIOS.find(r => r.id === 'rfd900x');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('regression #21: a grant expires at its own deadline even while the link stays fresh', () => {
  const s = ctx.makeSwarm({
    count: 2, airframe: Q450, radio: RFD, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
    videoOn: true, videoKbps: 100,
  });
  const d = s.drones[0];
  d.mode = 'ok';
  // Isolate the ONBOARD check: mute every drone's uplink so C2 never learns
  // of them and issues no orders at all — the only grant in play is the one
  // planted here, expiring at t=5, while heartbeats keep lastC2 fresh.
  for (const dr of s.drones) dr.nextTlm = 1e9;
  d.order = { role: 'mission', slot: -1, k: 0, upstream: 'C2',
    videoOn: true, videoUntil: 5, target: { x: 600, y: 0 } };
  let sendsAfterExpiry = 0;
  s.captureOn = true;
  for (let t = 0; t <= 12; t += 0.25) {
    d.lastC2 = s.time; // heartbeats keep arriving — but no new grant
    ctx.stepSwarm(s, 0.25);
  }
  for (const e of s.net.cap) {
    if (e.ev === 'send' && e.kind === 'vid' && e.src === d.id && e.t > 5.5) sendsAfterExpiry++;
  }
  assert.strictEqual(sendsAfterExpiry, 0,
    'drone kept streaming ' + sendsAfterExpiry + ' chunks after its grant expired');
});

test('a grant within its deadline streams (guard)', () => {
  const s = ctx.makeSwarm({
    count: 2, airframe: Q450, radio: RFD, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
    videoOn: true, videoKbps: 100,
  });
  const d = s.drones[0];
  d.mode = 'ok';
  d.lastC2 = 0;
  d.order = { role: 'mission', slot: -1, k: 0, upstream: 'C2',
    videoOn: true, videoUntil: 30, target: { x: 600, y: 0 } };
  s.captureOn = true;
  for (let t = 0; t <= 3; t += 0.25) { d.lastC2 = s.time; ctx.stepSwarm(s, 0.25); }
  const sent = s.net.cap.some(e => e.ev === 'send' && e.kind === 'vid');
  assert.ok(sent, 'a valid grant must stream');
});

test('orders from C2 carry the absolute grant expiry', () => {
  const s = ctx.makeSwarm({
    count: 3, airframe: Q450, radio: RFD, envFactor: 1,
    targetX: 400, targetY: 0, altitudeM: 50, seed: 42,
    videoOn: true, videoKbps: 100,
  });
  for (let i = 0; i < 120; i++) ctx.stepSwarm(s, 0.25); // let C2 grant and order
  const granted = s.drones.find(d => d.order && d.order.videoOn);
  assert.ok(granted, 'someone must hold a grant');
  assert.ok(granted.order.videoUntil != null && isFinite(granted.order.videoUntil),
    'grant order must carry an absolute expiry, got ' + granted.order.videoUntil);
});
