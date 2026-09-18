// Findings #3/#4/#5/#16 (review of ffb35e6, B1/B15/B16): the transmission
// scheduler decided outcomes at ENQUEUE time and never reconciled its
// channel reservations with reality —
//   #3 unicast RF/liveness rolled when scheduled, trusted when fired;
//   #4 forwarded broadcast copies bypassed the channel/duty queues;
//   #5 expired traffic kept the channel reserved (and t=0 packets never aged);
//   #16 airtime billed at both enqueue and fire (utilization double-count).
// These tests drive net.js directly with a hand-stepped clock so every
// assertion is about the scheduler, not swarm dynamics.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3'); // 64 kbps, sub-GHz channel
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function mk(count) {
  const s = ctx.makeSwarm({
    count, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
  s.time = 0;
  return s;
}

function run(s, from, to, dt) {
  for (let t = from; t <= to + 1e-9; t += dt) { s.time = t; ctx.stepNet(s, dt); }
}

test('regression #3: telemetry queued behind a busy channel dies with its sender', () => {
  const s = mk(1);
  const d = s.drones[0];
  d.x = 80; d.y = 0;
  s.net.chanBusyUntil['sub1g'] = 2; // transmission must wait 2 s
  assert.ok(ctx.sendPacket(s, 'tlm', d.id, 'C2', { x: 80, y: 0 }), 'send accepted');
  ctx.killDrone(s, d); // sender destroyed before its slot comes up
  run(s, 0, 4, 0.05);
  assert.strictEqual(s.net.delivered, 0, 'telemetry from a dead sender was delivered');
});

test('regression #3: a command is lost when the receiver leaves range before transmission', () => {
  const s = mk(1);
  const d = s.drones[0];
  d.x = 80; d.y = 0;
  s.net.chanBusyUntil['sub1g'] = 2;
  assert.ok(ctx.sendPacket(s, 'cmd', 'C2', d.id, { role: 'mission' }), 'send accepted');
  d.x = 1e6; // receiver flies far out of range while the packet waits
  run(s, 0, 4, 0.05);
  assert.strictEqual(s.net.delivered, 0, 'command delivered to a receiver 1000 km away');
  assert.ok(s.net.dropped >= 1, 'loss must be recorded');
});

test('regression #4: forwarded broadcast copies serialize on the shared channel', () => {
  const s = mk(3);
  s.drones[0].x = 60; s.drones[0].y = 0;
  s.drones[1].x = 120; s.drones[1].y = 0;
  s.drones[2].x = 60; s.drones[2].y = 60;
  s.time = 0;
  ctx.sendBroadcast(s, 'C2', { seq: 1, orders: {} }, 8000); // 1 s of airtime at 64 kbps
  run(s, 0, 6, 0.05); // C2 copy fires, every recipient forwards in turn
  const air = (8000 * 8) / (64 * 1000);
  // Every drone that heard the table re-transmitted it; their ACTUAL
  // emission starts (txAt) must be spaced by at least one full airtime —
  // i.e. serialized on the shared channel, never in parallel.
  const starts = s.drones.map(d => s.net.txAt[d.id]).filter(t => t != null).sort((a, b) => a - b);
  assert.ok(starts.length >= 2, 'expected at least two forwarded transmissions, got ' + starts.length);
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] - starts[i - 1] >= air - 1e-9,
      'forwarded copies overlap on air: starts at ' + starts.join(', '));
  }
  // And the channel clock reflects the serial total: C2 + each forward.
  assert.ok((s.net.chanBusyUntil['sub1g'] || 0) >= air * (1 + starts.length) - 1e-6,
    'channel clock did not account for serialized forwards');
});

test('regression #5: expired queued traffic releases the channel for fresh commands', () => {
  const s = mk(1);
  const d = s.drones[0];
  d.x = 80; d.y = 0;
  s.time = 0;
  for (let i = 0; i < 20; i++) ctx.sendPacket(s, 'cmd', 'C2', d.id, { i }, 8000); // 1 s air each
  run(s, 0, 10.45, 0.05); // TTL (10 s) mows down the queue's tail
  s.time = 10.5;
  assert.ok(ctx.sendPacket(s, 'cmd', 'C2', d.id, { fresh: true }), 'fresh send accepted');
  run(s, 10.5, 12.6, 0.05);
  const freshArrived = d.inbox.some(m => m.payload && m.payload.fresh === true);
  assert.ok(freshArrived,
    'fresh command still waiting behind reservations held by expired traffic');
});

test('regression #5: a packet sent at t=0 ages and expires like any other', () => {
  const s = mk(1);
  const d = s.drones[0];
  d.x = 80; d.y = 0;
  s.net.chanBusyUntil['sub1g'] = 15; // parked well past the 6 s telemetry TTL
  s.time = 0;
  ctx.sendPacket(s, 'tlm', d.id, 'C2', {});
  run(s, 0, 16, 0.25);
  assert.strictEqual(s.net.delivered, 0, 'a t=0 packet outlived its TTL and delivered');
  assert.ok(s.net.dropped >= 1, 'expiry must be recorded as a drop');
});

test('F07: expiry and eligibility in the same tick do not emit or advance clocks', () => {
  const s = mk(1), d = s.drones[0];
  d.x = 80; d.y = 0;
  s.captureOn = true;
  s.time = 1;
  s.net.nodeTxUntil.C2 = 11.05;
  assert.ok(ctx.sendPacket(s, 'cmd', 'C2', d.id, {}, 8000));
  for (let tick = 20; tick <= 220; tick++) {
    s.time = tick / 20;
    ctx.stepNet(s, 0.05);
  }
  s.time = 11.05;
  ctx.stepNet(s, 0.05);
  assert.strictEqual(s.net.packets.length, 0);
  assert.strictEqual(s.net.dropped, 1);
  assert.strictEqual(s.net.cap.filter(e => e.reason === 'ttl-expired').length, 1);
  assert.strictEqual(s.net.txAt.C2, undefined);
  assert.strictEqual(s.net.chanBusyUntil.sub1g, undefined);
  assert.strictEqual(s.net.nodeTxUntil.C2, 11.05);
  assert.strictEqual(s.net.nodeDutyUntil.C2, undefined);
  assert.strictEqual(s.net.chanPendingSec.sub1g, 0);
  assert.ok(ctx.sendPacket(s, 'cmd', 'C2', d.id, { fresh: true }));
  ctx.stepNet(s, 0);
  assert.strictEqual(s.net.packets[0].fired, true);
  assert.ok(Math.abs(s.net.chanBusyUntil.sub1g - 11.056) < 1e-9);
});

for (const endpoint of ['sender', 'receiver']) {
  test('F08: ' + endpoint + ' death during airtime invalidates the unfinished frame', () => {
    const s = mk(2), sender = s.drones[0], receiver = s.drones[1];
    sender.x = 80; sender.y = 0;
    receiver.x = 100; receiver.y = 0;
    s.net.rng = () => 0.01;
    s.time = 1;
    assert.ok(ctx.sendPacket(s, 'cmd', sender.id, receiver.id, {}, 8000));
    ctx.stepNet(s, 0);
    assert.strictEqual(s.net.packets[0].fired, true);
    s.time = 1.5;
    ctx.killDrone(s, endpoint === 'sender' ? sender : receiver);
    ctx.stepNet(s, 0.5);
    if (endpoint === 'receiver') receiver.mode = 'ok';
    run(s, 1.55, 2.1, 0.05);
    assert.strictEqual(s.net.delivered, 0);
    assert.strictEqual(receiver.inbox.length, 0);
    assert.strictEqual(s.net.dropped, 1);
  });
}

test('F08: sender death after airtime completion preserves pending delivery', () => {
  const s = mk(1), d = s.drones[0];
  d.x = 80; d.y = 0;
  s.net.rng = () => 0.01;
  s.time = 1;
  assert.ok(ctx.sendPacket(s, 'tlm', d.id, 'C2', { x: 80 }, 8000));
  ctx.stepNet(s, 0);
  s.time = 2;
  ctx.stepNet(s, 1);
  assert.strictEqual(s.net.delivered, 0);
  s.time = 2.01;
  ctx.killDrone(s, d);
  ctx.stepNet(s, 0.01);
  s.time = 2.05;
  ctx.stepNet(s, 0.04);
  assert.strictEqual(s.net.delivered, 1);
  assert.strictEqual(s.c2.inbox.length, 1);
});

test('F08: retries sample RF only at each actual attempt start', () => {
  const local = loadCore();
  const s = mk(1), d = s.drones[0];
  d.x = 80; d.y = 0;
  let margin = 2, rolls = 0;
  local.liveMarginDb = () => margin;
  s.net.rng = () => { rolls++; return 0.9; };
  s.time = 1;
  assert.ok(local.sendPacket(s, 'cmd', 'C2', d.id, {}, 8000));
  local.stepNet(s, 0);
  assert.strictEqual(rolls, 1);
  assert.strictEqual(s.net.dropped, 0);
  assert.strictEqual(s.net.chanBusyUntil.sub1g, 2);
  s.time = 2;
  local.stepNet(s, 1);
  assert.strictEqual(rolls, 1);
  margin = 30;
  s.time = 2.02;
  local.stepNet(s, 0.02);
  assert.strictEqual(rolls, 2);
  s.time = 3.05;
  local.stepNet(s, 1.03);
  assert.strictEqual(s.net.delivered, 1);
  assert.strictEqual(d.inbox[0].retries, 1);
});

for (const kind of ['cmd', 'bcast']) {
  test('F09: ' + kind + ' airtime straddling reporting windows is split by overlap', () => {
    const s = mk(1), d = s.drones[0];
    d.x = kind === 'bcast' ? 1e6 : 80; d.y = 0;
    s.net.rng = () => 0.01;
    s.time = 4.9;
    if (kind === 'bcast') ctx.sendBroadcast(s, 'C2', { seq: 1, orders: {} }, 8000);
    else assert.ok(ctx.sendPacket(s, 'cmd', 'C2', d.id, {}, 8000));
    ctx.stepNet(s, 4.9);
    s.time = 5;
    ctx.stepNet(s, 0.1);
    assert.ok(Math.abs(s.net.utilization - 0.02) < 1e-9, String(s.net.utilization));
    s.time = 10;
    ctx.stepNet(s, 5);
    assert.ok(Math.abs(s.net.utilization - 0.18) < 1e-9, String(s.net.utilization));
  });
}

test('F09: a broadcast longer than two windows reports each occupied portion', () => {
  const s = mk(1);
  s.drones[0].x = 1e6;
  s.time = 4;
  ctx.sendBroadcast(s, 'C2', { seq: 1, orders: {} }, 96000);
  ctx.stepNet(s, 4);
  for (const [t, expected] of [[5, 0.2], [10, 1], [15, 1], [20, 0.2], [25, 0]]) {
    s.time = t;
    ctx.stepNet(s, 5);
    assert.ok(Math.abs(s.net.utilization - expected) < 1e-9, t + ': ' + s.net.utilization);
  }
});

test('F07: expired retries never emit after a duty-cycle wait', () => {
  const local = loadCore();
  const s = mk(1), d = s.drones[0];
  d.x = 80; d.y = 0;
  d.radio = { ...SIK, dutyCycle: 0.05 };
  local.liveMarginDb = () => 2;
  s.net.rng = () => 0.9;
  s.time = 1;
  assert.ok(local.sendPacket(s, 'cmd', 'C2', d.id, {}, 8000));
  local.stepNet(s, 0);
  s.time = 2;
  local.stepNet(s, 1);
  assert.strictEqual(s.net.packets[0].fired, false);
  s.time = 21;
  local.stepNet(s, 19);
  assert.strictEqual(s.net.txAt.C2, 1);
  assert.strictEqual(s.net.chanBusyUntil.sub1g, 2);
  assert.ok(Math.abs(s.net.nodeDutyUntil.C2 - 21) < 1e-9);
  assert.strictEqual(s.net.chanPendingSec.sub1g, 0);
  assert.strictEqual(s.net.dropped, 1);
});

for (const endpoint of ['sender', 'receiver']) {
  test('F08: removing the ' + endpoint + ' invalidates an active attempt', () => {
    const s = mk(2), sender = s.drones[0], receiver = s.drones[1];
    sender.x = 80; sender.y = 0;
    receiver.x = 100; receiver.y = 0;
    s.net.rng = () => 0.01;
    s.time = 1;
    assert.ok(ctx.sendPacket(s, 'cmd', sender.id, receiver.id, {}, 8000));
    ctx.stepNet(s, 0);
    s.drones.splice(endpoint === 'sender' ? 0 : 1, 1);
    s.time = 1.5;
    ctx.stepNet(s, 0.5);
    s.time = 2.1;
    ctx.stepNet(s, 0.6);
    assert.strictEqual(s.net.delivered, 0);
    assert.strictEqual(s.net.dropped, 1);
  });
}

test('F08: sender death cuts off airtime and releases the active channel', () => {
  const s = mk(1), d = s.drones[0];
  d.x = 80; d.y = 0;
  s.net.rng = () => 0.01;
  s.time = 1;
  assert.ok(ctx.sendPacket(s, 'tlm', d.id, 'C2', {}, 8000));
  ctx.stepNet(s, 0);
  s.time = 1.5;
  ctx.killDrone(s, d);
  ctx.stepNet(s, 0.5);
  assert.strictEqual(s.net.chanBusyUntil.sub1g, 1.5);
  assert.strictEqual(s.net.nodeTxUntil[d.id], 1.5);
  s.time = 5;
  ctx.stepNet(s, 3.5);
  assert.ok(Math.abs(s.net.utilization - 0.1) < 1e-9);
});

test('F09: retry gaps are not airtime and each retry bills its own interval', () => {
  const local = loadCore();
  const s = mk(1), d = s.drones[0];
  d.x = 80; d.y = 0;
  local.liveMarginDb = () => 2;
  s.net.rng = () => 0.9;
  s.time = 4.9;
  assert.ok(local.sendPacket(s, 'cmd', 'C2', d.id, {}, 8000));
  local.stepNet(s, 0);
  s.time = 5;
  local.stepNet(s, 0.1);
  assert.ok(Math.abs(s.net.utilization - 0.02) < 1e-9);
  s.time = 10;
  local.stepNet(s, 5);
  assert.ok(Math.abs(s.net.utilization - 0.58) < 1e-9, String(s.net.utilization));
  assert.ok(Math.abs(s.net.chanBusyUntil.sub1g - 7.94) < 1e-9);
  assert.ok(Math.abs(s.net.txAt.C2 - 6.94) < 1e-9);
  assert.strictEqual(s.net.dropped, 1);
  assert.strictEqual(s.net.chanPendingSec.sub1g, 0);
  assert.strictEqual(s.net.airIntervals.length, 0);
});

test('F09: independent channels report peak occupancy instead of summed occupancy', () => {
  const s = mk(2), a = s.drones[0], b = s.drones[1];
  a.x = 1e6; a.y = 0;
  b.x = -1e6; b.y = 0;
  b.radio = { ...SIK, band: '2.4g', freqMHz: 2400 };
  s.time = 4.9;
  ctx.sendBroadcast(s, a.id, { seq: 1, orders: {} }, 8000);
  ctx.sendBroadcast(s, b.id, { seq: 1, orders: {} }, 16000);
  ctx.stepNet(s, 0);
  assert.strictEqual(s.net.txAt[a.id], 4.9);
  assert.strictEqual(s.net.txAt[b.id], 4.9);
  s.time = 5;
  ctx.stepNet(s, 0.1);
  assert.ok(Math.abs(s.net.utilization - 0.02) < 1e-9);
  s.time = 10;
  ctx.stepNet(s, 5);
  assert.ok(Math.abs(s.net.utilization - 0.38) < 1e-9);
});

test('F09: skipped reporting boundaries retain the latest full window', () => {
  const s = mk(1);
  s.drones[0].x = 1e6;
  s.time = 4;
  ctx.sendBroadcast(s, 'C2', { seq: 1, orders: {} }, 96000);
  ctx.stepNet(s, 4);
  s.time = 20;
  ctx.stepNet(s, 16);
  assert.ok(Math.abs(s.net.utilization - 0.2) < 1e-9);
  assert.strictEqual(s.net.utilSince, 20);
  assert.strictEqual(s.net.airIntervals.length, 0);
});

test('regression #16: one second of broadcast airtime bills one second, not two', () => {
  const s = mk(1);
  s.drones[0].x = 1e6; // nobody in range — no re-transmissions, no extra air
  s.time = 0;
  ctx.sendBroadcast(s, 'C2', { seq: 1, orders: {} }, 8000); // exactly 1 s on air
  run(s, 0, 5.1, 0.05); // one full utilization window
  assert.ok(s.net.utilization > 0.15 && s.net.utilization < 0.25,
    '1 s of air in a 5 s window must read ~0.20, got ' + s.net.utilization.toFixed(3));
});
