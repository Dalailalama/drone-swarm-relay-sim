// Audit swarm-onboard/ONB-06: a drone's own telemetry schedule and its
// link-loss failsafe thresholds were computed live from C2's PRIVATE chain
// plan (s.c2.chainPlan), the network layer's internals (floodCopiesEma) and
// the true count of live drones — so they changed with no packet received
// (LoRa868, 12 x8, unicast: telemetry 9.6 s -> 48 s and hold-after
// 184 s -> 307 s the moment C2 replanned). C2 now ships the cadence it paces
// traffic at inside every order, as a GCS sets SR*/COM_DL_LOSS_T, and the
// drone times itself from what it was last told.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const LORA = R.RADIOS.find(r => r.id === 'lora868');
const X8 = A.AIRFRAMES.find(a => a.id === 'x8');

function mk() {
  const s = ctx.makeSwarm({
    count: 12, airframe: X8, radio: LORA, envFactor: 1, broadcastC2: false,
    targetX: 6000, targetY: 0, altitudeM: 60, seed: 42,
  });
  s.c2.nextCmd = Infinity; // C2 stays quiet: nothing reaches the drone
  return s;
}

// What the drone does with its own timers, observed from outside: the next
// telemetry time it schedules, and whether a given silence trips 'hold'.
function tlmGap(s, d) {
  d.nextTlm = s.time;
  ctx.droneComms(s, d);
  return d.nextTlm - s.time;
}

test('ONB-06: C2 replanning in private does not move a drone\'s telemetry schedule or failsafe', () => {
  const s = mk();
  const d = s.drones[0];
  s.time = 400;
  d.lastC2 = s.time;
  const gap0 = tlmGap(s, d);
  const hold0 = Math.max(8, 3 * ctx.cmdIntervalSec(s, s.drones.length));
  // C2 privately plans a four-relay chain and six far drones die — no
  // packet carries either fact to this drone.
  s.c2.chainPlan = { feasible: true, slots: [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }] };
  for (const o of s.drones.slice(6)) o.mode = 'dead';
  const hold1 = Math.max(8, 3 * ctx.cmdIntervalSec(s, s.drones.length));
  assert.ok(hold1 > hold0 + 20, 'setup: the live formula must move (' + hold0.toFixed(0) + ' -> ' + hold1.toFixed(0) + ' s)');
  assert.strictEqual(tlmGap(s, d), gap0, 'telemetry schedule moved with no packet received');
  d.lastC2 = s.time - (hold0 + hold1) / 2; // silent longer than it was told to tolerate
  ctx.droneComms(s, d);
  assert.strictEqual(d.mode, 'hold', 'the failsafe threshold moved with no packet received');
});

test('ONB-06: a delivered order retunes the drone to C2\'s current cadence', () => {
  const s = mk();
  const d = s.drones[0];
  s.time = 400;
  d.lastC2 = s.time;
  d.inbox.push({ kind: 'cmd', src: 'C2', payload: {
    ...d.order, c2: { x: 0, y: 0, at: s.time }, cadence: { tlmSec: 48, cmdSec: 70 },
  } });
  assert.strictEqual(tlmGap(s, d), 48);
  d.lastC2 = s.time - 200; // past the old 3 x cmd threshold, inside 3 x 70 s
  ctx.droneComms(s, d);
  assert.strictEqual(d.mode, 'ok', 'a 200 s gap is inside the advertised 210 s tolerance');
});

test('ONB-06: C2\'s orders carry the cadence it paces traffic at', () => {
  const s = ctx.makeSwarm({
    count: 4, airframe: X8, radio: LORA, envFactor: 1,
    targetX: 3000, targetY: 0, altitudeM: 60, seed: 42,
  });
  while (s.time < 120) ctx.stepSwarm(s, 0.05);
  const d = s.drones.find(x => x.lastC2 > 60);
  assert.ok(d, 'some drone must have heard C2');
  assert.ok(d.linkCadence && d.linkCadence.tlmSec >= 2 && d.linkCadence.cmdSec >= 1,
    'the drone must hold the cadence C2 sent: ' + JSON.stringify(d.linkCadence));
});
