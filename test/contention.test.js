// Test suite reproducing channel contention, retry delays, and dead drone broadcasts (B01, B16, B17).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3'); // 64 kbps
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('reproduction B01: shared-channel contention must serialize airtime', () => {
  const s = ctx.makeSwarm({
    count: 4,
    airframe: Q450,
    radio: SIK,
    envFactor: 1,
    targetX: 300, targetY: 0,
    altitudeM: 50,
    seed: 42,
  });

  // Step briefly so drones are placed and links exist
  ctx.stepSwarm(s, 0.5);

  // Send multiple large packets (e.g. 5 packets of 8000 bytes each on a 64 kbps link = 1s airtime each = 5s total airtime)
  const bytes = 8000; // 8000 * 8 / 64000 = 1.0s airtime each
  let sent = 0;
  for (let i = 0; i < 5; i++) {
    const ok = ctx.sendPacket(s, 'cmd', 'C2', s.drones[0].id, { test: i }, bytes);
    if (ok) sent++;
  }
  assert.ok(sent >= 2, 'packets should be sent');

  // Step by only 1.1 seconds:
  // With 1.0s airtime each, a shared 64 kbps channel can deliver at most 1-2 packets in 1.1s!
  // Bug 1 delivered all packets in 1.1s.
  ctx.stepSwarm(s, 1.1);

  // The total delivered large packets must be at most 2 in 1.1s
  const delivered = s.drones[0].inbox.filter(p => p.bytes === bytes).length;
  assert.ok(delivered <= 2, 'in 1.1s on a 64kbps link, at most 1-2 packets of 1s airtime should be delivered, got ' + delivered);
});

test('reproduction B17: dead drones cannot transmit queued broadcasts', () => {
  const s = ctx.makeSwarm({
    count: 4,
    airframe: Q450,
    radio: SIK,
    envFactor: 1,
    targetX: 200, targetY: 0,
    altitudeM: 50,
    seed: 42,
    broadcast: true,
  });
  ctx.stepSwarm(s, 0.5);

  const d = s.drones[0];
  // Schedule a broadcast from drone 0
  ctx.sendBroadcast(s, d.id, { seq: 999, orders: {} }, 64);
  assert.ok(s.net.bcasts.some(b => b.srcId === d.id && b.payload.seq === 999), 'broadcast queued');

  // Drone 0 is killed before the broadcast fires
  ctx.killDrone(s, d);
  assert.strictEqual(ctx.alive(d), false);

  // Step past broadcast fire time
  ctx.stepSwarm(s, 1.0);

  // Other drones must not have received the broadcast from the dead drone
  for (let i = 1; i < s.drones.length; i++) {
    const bcasts = s.drones[i].inbox.filter(m => m.payload && m.payload.seq === 999);
    assert.strictEqual(bcasts.length, 0, 'dead drone broadcast must not be delivered to ' + s.drones[i].id);
  }
});
