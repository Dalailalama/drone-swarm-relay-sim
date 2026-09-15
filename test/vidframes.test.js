// Finding #15 (review of ffb35e6, B12-adjacent): video loss counted
// FRAGMENTS as frames — one lost 1024-byte chunk (4 fragments) reported
// droppedFrames=4, and incomplete reassembly could add another later. A
// frame must terminate exactly once: delivered when the last fragment
// lands, dropped the FIRST time any of it is lost, late fragments of a
// dead frame discarded without effect.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function mk() {
  const s = ctx.makeSwarm({
    count: 1, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
  s.drones[0].x = 80; s.drones[0].y = 0;
  s.time = 0;
  return s;
}

function run(s, from, to, dt) {
  for (let t = from; t <= to + 1e-9; t += dt) { s.time = t; ctx.stepNet(s, dt); }
}

test('regression #15: one lost 4-fragment chunk counts as ONE dropped frame', () => {
  // Reviewer probe: 1024-byte chunk -> 4 fragments at the 256-byte MTU.
  // Sender dies while they queue: the frame is lost once, not four times.
  const s = mk();
  s.net.nodeTxUntil[s.drones[0].id] = 5; // fragments wait on their own radio
  assert.ok(ctx.sendPacket(s, 'vid', s.drones[0].id, 'C2', null, 1024), 'chunk accepted');
  ctx.killDrone(s, s.drones[0]);
  run(s, 0, 8, 0.05);
  assert.strictEqual(s.net.vid.framesDelivered, 0);
  assert.strictEqual(s.net.vid.droppedFrames, 1,
    'one dead chunk must count once, got ' + s.net.vid.droppedFrames);
});

test('regression #15: partial delivery + expiry still counts ONE dropped frame', () => {
  // Park the channel so the tail fragments cross the 3 s video TTL: some
  // fragments deliver, the rest expire, reassembly gives up — one frame died.
  const s = mk();
  s.net.nodeTxUntil[s.drones[0].id] = 2.9; // tail fragments will cross the 3 s TTL
  assert.ok(ctx.sendPacket(s, 'vid', s.drones[0].id, 'C2', null, 1024), 'chunk accepted');
  run(s, 0, 10, 0.05); // long enough for the reassembly pruner to fire too
  assert.strictEqual(s.net.vid.framesDelivered, 0, 'incomplete frame must not count as delivered');
  assert.strictEqual(s.net.vid.droppedFrames, 1,
    'fragment TTLs + reassembly expiry must merge into one loss, got ' + s.net.vid.droppedFrames);
});

test('regression #15: a late fragment of a dead frame is discarded without effect', () => {
  const s = mk();
  // Tombstone the frame by hand, then let a straggler fragment "arrive".
  s.net.vidDropped.set('vf-dead', s.time);
  s.net.vid.droppedFrames = 1;
  ctx.deliverPacket(s, { kind: 'vid', src: s.drones[0].id, dst: 'C2', frameId: 'vf-dead', fragIdx: 3, fragCount: 4, pid: 'p999', path: [s.drones[0].id, 'C2'], hop: 1 });
  assert.strictEqual(s.net.vid.framesDelivered, 0, 'dead frame must not resurrect');
  assert.strictEqual((s.c2.vidReassembly && s.c2.vidReassembly.size) || 0, 0,
    'late fragment must not recreate a reassembly entry');
  assert.strictEqual(s.net.vid.droppedFrames, 1, 'no double count on stragglers');
});

test('an intact fragmented chunk still delivers exactly once', () => {
  const s = mk();
  assert.ok(ctx.sendPacket(s, 'vid', s.drones[0].id, 'C2', null, 1024), 'chunk accepted');
  run(s, 0, 2, 0.05);
  assert.strictEqual(s.net.vid.framesDelivered, 1);
  assert.strictEqual(s.net.vid.droppedFrames, 0);
});
