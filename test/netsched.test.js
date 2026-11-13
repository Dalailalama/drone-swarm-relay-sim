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
const fs = require('node:fs');
const path = require('node:path');
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

test('C07: sender death before airtime ends drops packet; death after airtime ends preserves reception', () => {
  // 1. Sender death before airtime ends
  const s1 = mk(2), sender1 = s1.drones[0], receiver1 = s1.drones[1];
  sender1.x = 50; sender1.y = 0;
  receiver1.x = 100; receiver1.y = 0;
  s1.net.rng = () => 0.01;
  s1.time = 1.0;
  assert.ok(ctx.sendPacket(s1, 'cmd', sender1.id, receiver1.id, {}, 8000));
  ctx.stepNet(s1, 0);
  // Attempt runs from 1.0 to 2.0
  s1.time = 1.8;
  ctx.killDrone(s1, sender1);
  ctx.stepNet(s1, 0.8);
  s1.time = 2.5;
  ctx.stepNet(s1, 0.7);
  assert.strictEqual(s1.net.delivered, 0, 'death before airtime ends must drop the packet');
  assert.strictEqual(s1.net.dropped, 1);

  // 2. Sender death AFTER airtime ends preserves already-transmitted packet
  const s2 = mk(2), sender2 = s2.drones[0], receiver2 = s2.drones[1];
  sender2.x = 50; sender2.y = 0;
  receiver2.x = 100; receiver2.y = 0;
  s2.net.rng = () => 0.01;
  s2.time = 1.0;
  assert.ok(ctx.sendPacket(s2, 'cmd', sender2.id, receiver2.id, {}, 8000));
  ctx.stepNet(s2, 0);
  // Let airtime complete at 2.0
  s2.time = 2.01;
  ctx.stepNet(s2, 1.01);
  // Sender dies AFTER airtime completed, before deliverPacket processing at 2.05
  ctx.killDrone(s2, sender2);
  s2.time = 2.05;
  ctx.stepNet(s2, 0.04);
  assert.strictEqual(s2.net.delivered, 1, 'death after airtime ends must NOT invalidate completed transmission');
});

test('C07: immediate interruption recording survives subsequent endpoint revival', () => {
  const s = mk(2), sender = s.drones[0], receiver = s.drones[1];
  sender.x = 50; sender.y = 0;
  receiver.x = 100; receiver.y = 0;
  s.net.rng = () => 0.01;
  s.time = 1.0;
  assert.ok(ctx.sendPacket(s, 'cmd', sender.id, receiver.id, {}, 8000));
  ctx.stepNet(s, 0);

  // Interruption happens at 1.5 during attempt (1.0 - 2.0)
  s.time = 1.5;
  ctx.killDrone(s, sender);
  assert.strictEqual(s.net.packets[0].attempt.interruptedAt, 1.5, 'interruptedAt must be recorded immediately');

  // Sender is revived before airtime finishes, clearing drone endpoint timestamp
  sender.mode = 'ok';
  sender.endpointDeadAt = undefined;
  assert.ok(ctx.alive(sender), 'sender must be alive after revival');

  // Step past airtime completion
  s.time = 2.1;
  ctx.stepNet(s, 0.6);
  assert.strictEqual(s.net.delivered, 0, 'revival must not undo the recorded attempt interruption');
  assert.strictEqual(s.net.dropped, 1);
});

test('W05: delayed processing of recorded interruption truncates airtime and frees channel', () => {
  const s = mk(2), sender = s.drones[0], receiver = s.drones[1];
  sender.x = 50; sender.y = 0;
  receiver.x = 100; receiver.y = 0;
  s.net.rng = () => 0.01; // Ensure packet delivery probability passes
  s.time = 1.0;

  // 256-byte telemetry packet on 64 kbps (0.032s airtime, nominal end = 1.032)
  assert.ok(ctx.sendPacket(s, 'tlm', sender.id, receiver.id, { pad: 'x'.repeat(200) }, 256));
  ctx.stepNet(s, 0);
  const p = s.net.packets[0];
  assert.ok(p && p.attempt, 'packet attempt started');
  assert.strictEqual(p.attempt.start, 1.0);
  assert.strictEqual(p.attempt.end, 1.032);
  assert.strictEqual(s.net.chanBusyUntil['sub1g'], 1.032);

  // Sender killed at 1.02 (0.02s into transmission)
  s.time = 1.02;
  ctx.killDrone(s, sender);
  assert.strictEqual(p.attempt.interruptedAt, 1.02);

  // Delayed network step runs at 1.05 (after nominal airtime end 1.032)
  s.time = 1.05;
  ctx.stepNet(s, 0.03);

  // Packet dropped, but channel busy time and air bill truncated to 1.02
  assert.strictEqual(s.net.delivered, 0);
  assert.strictEqual(s.net.dropped, 1);
  assert.strictEqual(p.attempt.air.end, 1.02, 'air attempt end must be truncated to 1.02');
  assert.strictEqual(s.net.chanBusyUntil['sub1g'], 1.02, 'channel busy must be freed at 1.02, not 1.032');
  assert.strictEqual(s.net.nodeTxUntil[sender.id], 1.02, 'sender nodeTxUntil must be released at 1.02');

  // Step to window boundary at t=5.0: 0.02s airtime / 5s = 0.004 utilization
  s.time = 5.0;
  ctx.stepNet(s, 3.95);
  assert.ok(Math.abs(s.net.utilization - 0.004) < 1e-4, 'utilization must reflect only 0.020s airtime (got ' + s.net.utilization + ')');
});

// NET-01: C2 carries one matched radio unit per radio type, and a duty
// limit binds each transmitter separately — a LoRa unit's legal rest must
// not silence C2's unrelated 2.4 GHz unit.
test('NET-01: C2 duty/tx clocks are per radio unit, not shared across bands', () => {
  const LORA = R.RADIOS.find(r => r.id === 'lora868');
  const ESPNOW = R.RADIOS.find(r => r.id === 'espnow');
  const s = ctx.makeSwarm({
    count: 2, airframe: Q450, radio: LORA, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
  s.time = 0;
  const [a, b] = s.drones;
  a.x = 50; a.y = 0; a.radio = LORA;
  b.x = 0; b.y = 50; b.radio = ESPNOW;
  const starts = {};
  const orig = ctx.commitPacket;
  ctx.commitPacket = function (s2, p, eStart) {
    if (!(p.dst in starts)) starts[p.dst] = eStart;
    return orig(s2, p, eStart);
  };
  try {
    assert.ok(ctx.sendPacket(s, 'cmd', 'C2', a.id, { role: 'mission' }));
    assert.ok(ctx.sendPacket(s, 'cmd', 'C2', b.id, { role: 'mission' }));
    run(s, 0, 1, 0.05);
    assert.ok(starts[a.id] < 0.01, 'LoRa cmd starts at once');
    assert.ok(starts[b.id] < 0.01, 'ESP-NOW cmd waited on the LoRa unit (' + starts[b.id] + ' s)');
    // The LoRa unit's own duty rest still holds for its next transmission.
    const loraRest = Math.max(s.net.nodeDutyUntil.C2 || 0, s.net.nodeDutyUntil['C2@' + LORA.id] || 0);
    assert.ok(loraRest > 1, 'LoRa duty rest recorded');
    delete starts[a.id];
    s.time = 1;
    assert.ok(ctx.sendPacket(s, 'cmd', 'C2', a.id, { role: 'mission' }));
    run(s, 1, loraRest + 1, 0.05);
    assert.ok(starts[a.id] >= loraRest - 1e-9, 'second LoRa cmd ignored its duty rest');
  } finally {
    ctx.commitPacket = orig;
  }
});

// NET-03: pins the documented channel model — each channel is ONE swarm-wide
// collision-free timeline. Simultaneous sends from different drones (agility
// on or off) are serialized; no two billed intervals on a channel overlap.
for (const agility of [false, true]) {
  test('NET-03: same-channel transmissions never overlap (agility ' + agility + ')', () => {
    const s = ctx.makeSwarm({
      count: 4, airframe: Q450, radio: SIK, envFactor: 1, spectrumAgility: agility,
      targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
    });
    s.time = 0;
    s.drones.forEach((d, i) => { d.x = 60 + 20 * i; d.y = 10 * i; });
    const billed = [];
    const orig = ctx.billAir;
    ctx.billAir = function (s2, chan, start, end) {
      billed.push({ chan, start, end });
      return orig(s2, chan, start, end);
    };
    try {
      for (const d of s.drones) assert.ok(ctx.sendPacket(s, 'tlm', d.id, 'C2', { x: d.x, y: d.y }));
      for (const d of s.drones) assert.ok(ctx.sendPacket(s, 'cmd', 'C2', d.id, { role: 'mission' }));
      run(s, 0, 2, 0.05);
    } finally {
      ctx.billAir = orig;
    }
    assert.ok(billed.length >= 8, 'every packet aired');
    billed.sort((x, y) => x.start - y.start);
    for (let i = 1; i < billed.length; i++) {
      if (billed[i].chan !== billed[i - 1].chan) continue;
      assert.ok(billed[i].start >= billed[i - 1].end - 1e-12, 'overlap on ' + billed[i].chan);
    }
  });
}

// NET-05: a unicast order round ran a fresh all-pairs Dijkstra per drone
// (O(N^3) per round, ~0.5 s CPU at 100 drones). C2-sourced packets must ride
// the shared C2-rooted tree: same routes, no per-packet route search.
test('NET-05: C2 unicast orders follow the shared C2 tree without a per-packet Dijkstra', () => {
  const s = mk(6);
  s.drones.forEach((d, i) => { d.x = 150 * (i + 1); d.y = (i % 2) * 40; });
  let searches = 0;
  const orig = ctx.routePath;
  ctx.routePath = function (...args) { searches++; return orig(...args); };
  try {
    for (const d of s.drones) assert.ok(ctx.sendPacket(s, 'cmd', 'C2', d.id, { role: 'mission' }));
  } finally {
    ctx.routePath = orig;
  }
  assert.strictEqual(searches, 0, 'per-packet route search for a C2 order');
  for (const d of s.drones) {
    const p = s.net.packets.find(q => q.dst === d.id);
    assert.strictEqual(p.path.join('>'), ctx.pathToC2(s, d.id).slice().reverse().join('>'));
  }
});

// NET-06: the C2 tree cache must not outlive a relay's death — routes (and
// the uptime metric built on them) went through a dead relay for up to 0.5 s.
test('NET-06: a relay death invalidates the cached C2 tree on the same tick', () => {
  const s = mk(2);
  const range = ctx.usableRangeM(SIK, 1);
  const [relay, far] = s.drones;
  relay.x = 0.8 * range; relay.y = 0;
  far.x = 1.6 * range; far.y = 0;
  assert.strictEqual(ctx.pathToC2(s, far.id).join('>'), far.id + '>' + relay.id + '>C2', 'relayed route');
  s.time = 0.1;
  ctx.killDrone(s, relay);
  assert.strictEqual(ctx.pathToC2(s, far.id), null, 'route through a dead relay');
});

// A relay radio picked on the page while the relay wing is off flies on no
// drone, yet it widened the C2 tree's candidate-link span, so the page and
// the replay of its capture (which leaves the unflown radio out) could build
// different routes.
test('C2 tree: a relay radio with no relay wing does not change the routes', () => {
  const RFD = R.RADIOS.find(r => r.id === 'rfd900x');
  const X8 = A.AIRFRAMES.find(a => a.id === 'x8');
  const route = relayRadio => {
    const s = ctx.makeSwarm({
      count: 1, airframe: Q450, radio: SIK, envFactor: 1, targetX: 600, targetY: 0,
      altitudeM: 50, seed: 42, relayWing: 0, relayAirframe: X8, relayRadio,
    });
    s.time = 0;
    const d = s.drones[0];
    d.x = 3 * ctx.usableRangeM(SIK, 1); d.y = 0; // past the SiK fleet's 2.5x search span
    s.net.fades.set('C2|' + d.id, { db: 40, lastUsed: 0 }); // a deep up-fade keeps it linked
    const p = ctx.pathToC2(s, d.id);
    return p && p.join('>');
  };
  assert.strictEqual(route(RFD), route(null));
});

// NET-04: a drone that never heard a broadcast order table produced no drop
// anywhere, so broadcast C2 reported 0 % loss where unicast reported 50 % for
// the same unreachable drone. Broadcast reach is now scored per addressed
// drone when the next round supersedes it, and the control-plane loss ratio
// leaves video fragments out.
function orderRounds(broadcast, rounds) {
  const s = mk(2);
  const [near, far] = s.drones;
  near.x = 100; near.y = 0;
  far.x = 50000; far.y = 0; // 50 km: no route, never hears a table
  // A broadcast round is scored when the next one supersedes it, so the
  // broadcast run sends one extra round to close the last scored one.
  const sends = broadcast ? rounds + 1 : rounds;
  for (let r = 1; r <= sends; r++) {
    s.time = r - 1;
    if (broadcast) ctx.sendBroadcast(s, 'C2', { seq: r, orders: { [near.id]: {}, [far.id]: {} } }, 68);
    else for (const d of s.drones) ctx.sendPacket(s, 'cmd', 'C2', d.id, {}, 64);
    run(s, r - 1, r - 0.05, 0.05);
  }
  return s;
}

test('NET-04: an unreachable drone counts as lost in broadcast mode exactly as in unicast', () => {
  const bc = orderRounds(true, 10), uc = orderRounds(false, 10);
  assert.strictEqual(uc.net.dropped, 10, 'unicast: 10 orders to the far drone dropped');
  assert.strictEqual(bc.net.dropped, 10, 'broadcast: 10 rounds the far drone never heard must count as lost');
  assert.deepStrictEqual({ ...bc.net.byKind.bcast }, { delivered: 10, dropped: 10 });
  assert.deepStrictEqual({ ...uc.net.byKind.cmd }, { delivered: 10, dropped: 10 });
  assert.strictEqual(ctx.controlLossPct(bc), 50);
  assert.strictEqual(ctx.controlLossPct(uc), 50, 'same geometry, same loss in both C2 modes');
  // Video fragments are a different quantity (frame loss has its own metric).
  uc.net.byKind.vid = { delivered: 0, dropped: 1000 };
  assert.strictEqual(ctx.controlLossPct(uc), 50, 'video fragments leak into the control-plane loss');
});

// NET-07: the capture trace must agree with the counters, every packet event
// must join a send, and the header must admit a truncated rolling window.
const trace = (s, pid) => [...s.net.cap.filter(e => e.pid === pid).map(e => e.ev + (e.reason ? '(' + e.reason + ')' : ''))];

test('NET-07: a receiver that dies before arrival leaves a dead-dst drop, not a bare deliver', () => {
  const s = mk(1), d = s.drones[0];
  d.x = 50; d.y = 0;
  s.captureOn = true;
  s.net.rng = () => 0.01;
  s.time = 1.0;
  assert.ok(ctx.sendPacket(s, 'cmd', 'C2', d.id, {}, 8000)); // 1 s of airtime
  ctx.stepNet(s, 0);
  s.time = 2.005; ctx.stepNet(s, 1.005); // last bit landed at 2.0, arrival due at 2.02
  s.time = 2.01; ctx.killDrone(s, d);
  s.time = 2.05; ctx.stepNet(s, 0.04);
  assert.strictEqual(s.net.delivered, 0);
  assert.strictEqual(s.net.dropped, 1);
  assert.deepStrictEqual(trace(s, 'p0'), ['send', 'hop', 'drop(dead-dst)']);
});

// The same death at a RELAY: the drop must name the hop whose receiver died
// (far -> relay), not the next hop (relay -> C2), whose receiver is alive.
test('NET-07: a relay that dies before arrival is the dead-dst of the hop it was receiving', () => {
  const s = mk(2), [relay, far] = s.drones;
  relay.x = 150; relay.y = 0;
  far.x = 300; far.y = 0;
  s.captureOn = true;
  s.net.rng = () => 0.01;
  s.time = 1.0;
  const orig = ctx.pathToC2;
  ctx.pathToC2 = () => [far.id, relay.id, 'C2'];
  try {
    assert.ok(ctx.sendPacket(s, 'tlm', far.id, 'C2', {}, 8000)); // 1 s of airtime
  } finally {
    ctx.pathToC2 = orig;
  }
  ctx.stepNet(s, 0);
  s.time = 2.005; ctx.stepNet(s, 1.005); // last bit landed at 2.0, arrival due at 2.02
  s.time = 2.01; ctx.killDrone(s, relay);
  s.time = 2.05; ctx.stepNet(s, 0.04);
  assert.strictEqual(s.net.dropped, 1);
  assert.deepStrictEqual(trace(s, 'p0'), ['send', 'hop', 'drop(dead-dst)']);
  const drop = s.net.cap.find(e => e.ev === 'drop' && e.pid === 'p0');
  assert.deepStrictEqual([drop.from, drop.to], [far.id, relay.id], 'the dead receiver is the relay');
});

test('NET-07: every video fragment event joins its frame send', () => {
  const s = mk(1), d = s.drones[0];
  d.x = 50; d.y = 0;
  s.captureOn = true;
  s.time = 0;
  assert.ok(ctx.sendPacket(s, 'vid', d.id, 'C2', {}, 1000)); // 4 fragments
  run(s, 0, 2, 0.05);
  assert.strictEqual(s.net.vid.framesDelivered, 1);
  const send = s.net.cap.find(e => e.ev === 'send');
  assert.strictEqual(send.path, d.id + '>C2');
  assert.strictEqual(send.hops, 1);
  const sends = new Set(s.net.cap.filter(e => e.ev === 'send').map(e => e.pid));
  const pktEvents = s.net.cap.filter(e => e.pid && e.ev !== 'send');
  assert.strictEqual(pktEvents.length, 8, 'four hops and four deliveries');
  for (const e of pktEvents) {
    assert.ok(sends.has(e.pid) || sends.has(e.frameId), e.ev + ' ' + e.pid + ' cannot be joined to any send');
  }
});

test('NET-07: a send whose first hop is already down is logged before its drop and reports failure', () => {
  const s = mk(2);
  const [relay, far] = s.drones;
  relay.x = 300; far.x = 600;
  s.captureOn = true;
  ctx.killDrone(s, relay);
  const orig = ctx.pathToC2;
  ctx.pathToC2 = () => [far.id, relay.id, 'C2']; // a stale route through the dead relay
  let sent;
  try {
    sent = ctx.sendPacket(s, 'cmd', 'C2', far.id, {});
  } finally {
    ctx.pathToC2 = orig;
  }
  assert.strictEqual(sent, false, 'nothing was queued');
  assert.strictEqual(s.net.dropped, 1);
  assert.deepStrictEqual(trace(s, 'p0'), ['send', 'drop(dead-dst)']);
});

test('NET-07: the capture header says when the rolling window discarded events', () => {
  const s = mk(1);
  s.captureOn = true;
  let meta = JSON.parse(ctx.exportCaptureJSONL(s).split('\n')[0]);
  assert.strictEqual(meta.truncated, false);
  for (let i = 0; i < 5000; i++) ctx.capLog(s, { ev: 'hop', pid: 'x' });
  meta = JSON.parse(ctx.exportCaptureJSONL(s).split('\n')[0]);
  assert.strictEqual(meta.totalEvents, 5000);
  assert.strictEqual(meta.firstSeq, 5000 - s.net.cap.length);
  assert.strictEqual(meta.events, s.net.cap.length);
  assert.strictEqual(meta.truncated, true);
});

// capture-schema-stale: the README points third-party consumers at the
// schema at the top of net.js; it must name every event type and drop
// reason the code can emit.
test('capture schema: every event type and drop reason net.js emits is documented at its top', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'net.js'), 'utf8');
  const doc = src.slice(0, src.indexOf('const NET = {'));
  const emitted = new Set();
  const patterns = [/\bev: '([a-z]+)'/g, /\breason: '([a-z-]+)'/g, /discardPacket\(s, p, '([a-z-]+)'\)/g,
    /dropPacketBookkeeping\(s, p, '([a-z-]+)'/g, /interruptedReason = '([a-z-]+)'/g];
  for (const re of patterns) for (const m of src.matchAll(re)) emitted.add(m[1]);
  // ...and whatever a busy seeded mission actually writes (indirect reasons).
  const s = ctx.makeSwarm({
    count: 8, airframe: Q450, radio: SIK, envFactor: 1, targetX: 1500, targetY: 0,
    altitudeM: 50, seed: 7, broadcastC2: true, videoOn: true, videoKbps: 400, shadowSigmaDb: 6,
  });
  s.captureOn = true;
  while (s.time < 40) {
    ctx.stepSwarm(s, 0.25);
    if (Math.abs(s.time - 20) < 0.01) ctx.killDrone(s, s.drones[2]);
  }
  for (const e of s.net.cap) { emitted.add(e.ev); if (e.reason) emitted.add(e.reason); }
  for (const name of ['send', 'hop', 'deliver', 'drop', 'bcast', 'meta']) assert.ok(emitted.has(name), name);
  for (const name of emitted) {
    assert.ok(new RegExp("(^|[^a-z-])" + name + "([^a-z-]|$)", 'm').test(doc), name + ' is emitted but not documented');
  }
});

// NET-08: a drone's broadcast was dropped whenever its sender was dead at
// PROCESSING time, even if the death came after the last bit landed later in
// the same tick. Like unicast, the death time is compared with the airtime.
// 60 bytes at 64 kbps = 7.5 ms of air.
test('NET-08: a drone broadcast that finished airing is heard even if the sender dies later in the tick', () => {
  // When B hears the table it re-sends it at t=0.05, so the channel is then
  // busy until 0.0575.
  for (const [busyUntil, deathAt, heard, chanFreeAt] of [
    [0, 0.05, true, 0.0575],      // aired 0 .. 0.0075, died after
    [0, 0.004, false, 0.004],     // died mid-air: cut off, channel freed at death
    [0.01, 0.03, true, 0.0575],   // commit backdated to 0.01 within the tick, died after it aired
    [0.01, 0.012, false, 0.012],  // backdated commit, died mid-air
    [0.01, 0.005, false, 0.01],   // died before its slot: never keyed up
  ]) {
    const s = mk(2), [a, b] = s.drones;
    a.x = 100; a.y = 0;
    b.x = 150; b.y = 0;
    s.net.rng = () => 0.01;
    s.net.chanBusyUntil['sub1g'] = busyUntil;
    s.time = 0;
    ctx.sendBroadcast(s, a.id, { seq: 5, orders: {} }, 60);
    ctx.stepNet(s, 0);
    s.time = deathAt; ctx.killDrone(s, a);
    s.time = 0.05; ctx.stepNet(s, 0.05);
    const label = 'busy until ' + busyUntil + ', death at ' + deathAt;
    assert.strictEqual(b.bcastSeen === 5, heard, label + ': reception');
    assert.ok(Math.abs(s.net.chanBusyUntil['sub1g'] - chanFreeAt) < 1e-12,
      label + ': channel busy until ' + s.net.chanBusyUntil['sub1g'] + ', expected ' + chanFreeAt);
  }
});
