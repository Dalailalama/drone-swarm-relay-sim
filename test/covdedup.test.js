// Finding #17 (review of ffb35e6, B18): when the ACK for a black-box upload
// was lost, the drone re-sent the same samples and C2 re-applied them — one
// dead-zone sample's bad-cell weight went 3 -> 6 -> 9 with every replay,
// poisoning the learned coverage map with phantom certainty. C2 must apply
// each sample once (dedup by per-vehicle seq), still ACK duplicates so the
// sender stops retrying, and cope with a vehicle whose sequence restarts.
// Samples riding on telemetry must also bill their real payload bytes.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function mk() {
  return ctx.makeSwarm({
    count: 2, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
}

function badWeightAt(s, x, y) {
  const key = Math.floor(x / s.covCellM) + ',' + Math.floor(y / s.covCellM);
  const e = s.c2.cov.get(key);
  return e ? e.bad : 0;
}

function inject(s, deadLog, maxSeq, session = s.drones[0].deadLogSession) {
  s.c2.inbox.push({ kind: 'tlm', src: s.drones[0].id, dst: 'C2', payload: {
    x: 100, y: 0, battery: 90, role: 'mission',
    deadLog, deadLogMaxSeq: maxSeq, deadLogSession: session,
  } });
}

test('regression #17: a replayed sample is applied once, not stacked', () => {
  const s = mk();
  const sample = [{ x: 500, y: 0, seq: 1 }];
  inject(s, sample, 1);
  ctx.stepSwarm(s, 0.25);
  const first = badWeightAt(s, 500, 0);
  assert.ok(first > 0, 'first upload must mark the cell bad');
  // The ACK is lost; the drone re-sends the identical sample.
  inject(s, sample, 1);
  ctx.stepSwarm(s, 0.25);
  assert.strictEqual(badWeightAt(s, 500, 0), first,
    'replayed sample changed the evidence: ' + first + ' -> ' + badWeightAt(s, 500, 0));
});

test('regression #17: duplicates are still ACKed so the sender can stop retrying', () => {
  const s = mk();
  inject(s, [{ x: 500, y: 0, seq: 1 }], 1);
  ctx.stepSwarm(s, 0.25);
  s.net.packets.length = 0; // clear any in-flight acks for a clean count
  inject(s, [{ x: 500, y: 0, seq: 1 }], 1); // pure duplicate
  ctx.stepSwarm(s, 0.25);
  const ackQueuedOrSent = s.net.packets.some(p => p.kind === 'ack') ||
    s.drones[0].inbox.some(p => p.kind === 'ack');
  assert.ok(ackQueuedOrSent, 'duplicate upload must still be ACKed');
});

test('regression #17: a restarted vehicle (sequence reset) is not silenced', () => {
  const s = mk();
  inject(s, [{ x: 500, y: 0, seq: 7 }], 7);
  ctx.stepSwarm(s, 0.25);
  // Vehicle reinitializes; its black-box numbering starts over at 1.
  inject(s, [{ x: 900, y: 0, seq: 1 }], 1, 'boot-2');
  ctx.stepSwarm(s, 0.25);
  assert.ok(badWeightAt(s, 900, 0) > 0,
    'post-restart samples were dropped as stale duplicates');
});

test('F10: delayed lower sequence uploads do not reset session deduplication', () => {
  const s = mk();
  const a = { x: 500, y: 0, seq: 1 };
  const b = { x: 900, y: 0, seq: 2 };
  inject(s, [a, b], 2, 'boot-1');
  ctx.c2Step(s);
  inject(s, [a], 1, 'boot-1');
  ctx.c2Step(s);
  assert.strictEqual(badWeightAt(s, 500, 0), 3);
  inject(s, [a], 1, 'boot-2');
  ctx.c2Step(s);
  inject(s, [a, b], 2, 'boot-1');
  ctx.c2Step(s);
  assert.strictEqual(badWeightAt(s, 500, 0), 6);
  assert.strictEqual(badWeightAt(s, 900, 0), 3);
  const ack = s.net.packets.filter(p => p.kind === 'ack').at(-1);
  assert.strictEqual(ack.payload.ackDeadLogSession, 'boot-1');
});

test('F10: out-of-order unseen samples and different vehicles are counted once', () => {
  const s = mk();
  inject(s, [{ x: 900, y: 0, seq: 2 }], 2, 'boot-1');
  ctx.c2Step(s);
  inject(s, [{ x: 500, y: 0, seq: 1 }], 1, 'boot-1');
  ctx.c2Step(s);
  inject(s, [{ x: 900, y: 0, seq: 2 }], 2, 'boot-1');
  ctx.c2Step(s);
  assert.strictEqual(badWeightAt(s, 500, 0), 3);
  assert.strictEqual(badWeightAt(s, 900, 0), 3);
  inject(s, [{ x: 900, y: 0, seq: 2 }], 2, 'boot-1');
  s.c2.inbox[0].src = s.drones[1].id;
  ctx.c2Step(s);
  assert.strictEqual(badWeightAt(s, 900, 0), 6);
});

test('F10: session IDs stay stable and ACKs cannot clear another session', () => {
  const s = mk();
  const d = s.drones[0];
  assert.ok(d.deadLogSession);
  d.deadLog = [{ x: 500, y: 0, seq: 1 }];
  d.nextTlm = 0;
  ctx.droneComms(s, d);
  const session = d.deadLogSession;
  const upload = s.net.packets.find(p => p.kind === 'tlm' && p.src === d.id);
  assert.strictEqual(upload.payload.deadLogSession, session);
  d.inbox.push({ kind: 'ack', payload: { ackDeadLogSession: 'old-boot', ackDeadLogSeq: 1 } });
  ctx.droneComms(s, d);
  assert.strictEqual(d.deadLog.length, 1);
  assert.strictEqual(d.deadLogSession, session);
  d.inbox.push({ kind: 'ack', payload: { ackDeadLogSession: session, ackDeadLogSeq: 1 } });
  ctx.droneComms(s, d);
  assert.strictEqual(d.deadLog.length, 0);
  const rebooted = ctx.makeDrone(d.x, d.y, s.target, s.net.rng, Q450, SIK);
  rebooted.id = d.id;
  assert.notStrictEqual(rebooted.deadLogSession, session);
});

test('F10: a reordered ACK clears only its received samples, not sequence gaps', () => {
  const s = mk();
  const d = s.drones[0];
  const samples = [{ x: 500, y: 0, seq: 1 }, { x: 900, y: 0, seq: 2 }];
  d.deadLog = samples.slice();
  d.nextTlm = Infinity;
  inject(s, [samples[1]], 2);
  ctx.c2Step(s);
  const ack = s.net.packets.find(p => p.kind === 'ack');
  d.inbox.push(ack);
  ctx.droneComms(s, d);
  assert.strictEqual(d.deadLog.length, 1);
  assert.strictEqual(d.deadLog[0].seq, 1);
  inject(s, d.deadLog, 1);
  ctx.c2Step(s);
  assert.strictEqual(badWeightAt(s, 500, 0), 3);
  assert.strictEqual(mk().drones[0].deadLogSession, d.deadLogSession);
});

test('regression #17: telemetry carrying samples bills more than bare telemetry', () => {
  const s = mk();
  const d = s.drones[0];
  s.net.nodeTxUntil[d.id] = 50; // keep the packet queued so we can inspect it
  d.deadLog = [{ x: 400, y: 0 }, { x: 410, y: 0 }, { x: 420, y: 0 }];
  d.nextTlm = 0;
  ctx.stepSwarm(s, 0.25);
  const tlm = s.net.packets.find(p => p.kind === 'tlm' && p.src === d.id && p.payload && p.payload.deadLog);
  assert.ok(tlm, 'telemetry with samples must be queued');
  assert.ok(tlm.bytes > 32,
    'samples must cost real bytes on the air, got ' + tlm.bytes + ' B for 3 samples');
});
