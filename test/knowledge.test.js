// Audit C2-10 (knowledge separation): C2's staleness timer counted the
// truly-alive drones, so it shrank the moment drones died unseen; drones
// paced their telemetry off C2's private chain plan; and the one packet an
// RTB drone sends carried its TRUE position with no timestamp.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function swarm(count) {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count, airframe: Q450, radio: SIK, envFactor: 1, targetX: 1500, targetY: 0, seed: 11 });
  return { ctx, s };
}

test('C2-10: drones dying unseen do not move C2\'s staleness timer', () => {
  const { ctx, s } = swarm(60);
  for (let i = 0; i < 8; i++) ctx.stepSwarm(s, 0.25);
  const before = ctx.c2StaleAfterSec(s);
  for (const d of s.drones.slice(0, 40)) ctx.killDrone(s, d); // C2 has heard nothing of it
  assert.strictEqual(ctx.c2StaleAfterSec(s), before, 'C2 timing read truth liveness');
});

test('C2-10: a drone paces telemetry on the interval C2 announced, not on C2\'s private plan', () => {
  const { ctx, s } = swarm(60);
  while (s.time < 20) ctx.stepSwarm(s, 0.25);
  const d = s.drones.find(x => x.mode === 'ok' && x.tlmEvery);
  assert.ok(d, 'a drone must have heard C2 announce its report interval');
  // Replace C2's private plan with a far longer chain; nothing is transmitted.
  s.c2.chainPlan = { ...s.c2.chainPlan, slots: new Array(20).fill({ x: 0, y: 0 }) };
  d.nextTlm = s.time;
  const t0 = s.time;
  ctx.droneComms(s, d);
  assert.ok(Math.abs((d.nextTlm - t0) - d.tlmEvery) < 1e-9,
    'next report in ' + (d.nextTlm - t0).toFixed(2) + ' s, announced ' + d.tlmEvery.toFixed(2) + ' s');
});

test('C2-10: the RTB report carries the navigation position and a timestamp, never truth', () => {
  const { ctx, s } = swarm(6);
  while (s.time < 30) ctx.stepSwarm(s, 0.25);
  const d = s.drones.find(x => x.mode === 'ok');
  d.energyWh = ctx.usableWh(Q450) * 0.07;
  const sent = [];
  const real = ctx.sendPacket;
  ctx.sendPacket = (sim, kind, src, dst, payload, bytes) => {
    if (kind === 'tlm' && src === d.id && payload && payload.role === 'rtb') sent.push({ payload, x: d.x, y: d.y, t: sim.time });
    return real(sim, kind, src, dst, payload, bytes);
  };
  try { ctx.stepSwarm(s, 0.25); } finally { ctx.sendPacket = real; }
  assert.strictEqual(d.mode, 'rtb');
  assert.strictEqual(sent.length, 1, 'one RTB report');
  const { payload, x, y, t } = sent[0];
  assert.strictEqual(payload.posAt, t, 'RTB report must be timestamped');
  assert.ok(payload.x !== x || payload.y !== y, 'RTB report carried the true position');
  assert.ok(Math.hypot(payload.x - x, payload.y - y) < 20, 'GNSS-noised, not garbage');
});
