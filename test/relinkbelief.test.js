// Audit swarm-onboard/ONB-02: the link-loss ladder steered by the nav BELIEF
// but set its points and judged arrival on TRUTH. GNSS-denied, the drone's
// belief sat on the relink point while the arrival test (truth) never
// fired, so it stalled in attempt 1 until smart-RTH pulled it home on 9 %
// battery; and 'hold' aimed the belief at the TRUE hold position, flying
// the drone across its whole nav error instead of holding. A relink point
// it cannot physically reach (inside a tower) stalled the ladder the same
// way with healthy GNSS.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');
const DT = 0.05; // SIM_DT_SEC

function mk(extra) {
  return ctx.makeSwarm(Object.assign({
    count: 1, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 3,
  }, extra));
}

test('ONB-02: GNSS-denied, the relink ladder still advances to rtl well before the battery forces RTB', () => {
  const s = mk({ gpsZones: [{ id: 'GZ-1', x: 0, y: 0, rM: 5000, on: true }] });
  const d = s.drones[0];
  let relinkAt = null, hold = null, holdDrift = null;
  while (s.time < 1500 && d.mode !== 'rtl' && d.mode !== 'rtb' && alive(d)) {
    if (s.time >= 120) s.c2.nextCmd = Infinity; // C2 falls silent
    const before = d.mode;
    ctx.stepSwarm(s, DT);
    if (before !== 'hold' && d.mode === 'hold') hold = { t: s.time, x: d.belX, y: d.belY };
    if (hold && holdDrift == null && s.time - hold.t >= 20) holdDrift = Math.hypot(d.belX - hold.x, d.belY - hold.y);
    if (relinkAt == null && d.mode === 'relink') relinkAt = s.time;
  }
  assert.ok(hold && holdDrift != null, 'the drone must hold for 20 s first');
  assert.ok(holdDrift < 5, 'holding moved the nav belief ' + holdDrift.toFixed(1) + ' m — it chased its truth position');
  assert.ok(relinkAt != null, 'the ladder must reach relink');
  assert.strictEqual(d.mode, 'rtl', 'ended ' + d.mode + ' at t=' + s.time.toFixed(0) + ' s, attempt ' + d.relinkAttempt);
  assert.ok(s.time - relinkAt < 400, 'rtl took ' + (s.time - relinkAt).toFixed(0) + ' s after relink began');
});

test('ONB-02: a relink point inside a tower times out and the ladder moves on', () => {
  const s = mk();
  const d = s.drones[0];
  const step = R.usableRangeM(SIK, 1) * ctx.consts.FAILSAFE.relinkStepFrac;
  s.c2.nextCmd = Infinity;
  s.time = 100; d.lastC2 = 0;
  d.x = d.belX = 1000; d.y = d.belY = 0; d.vx = d.vy = 0;
  d.lastLinkX = 1000; d.lastLinkY = 0;
  d.mode = 'hold'; d.holdX = 1000; d.holdY = 0;
  // A 100 m tower sits exactly on attempt 2's fall-back point: the nearest
  // the drone can get is ~52 m from it, outside relinkArriveM (40 m).
  s.terrain = ctx.makeTerrain('flat');
  s.terrain.buildings = [{ x: 1000 - step, y: 0, w: 100, d: 100, heightM: 300 }];
  let attempt2At = null;
  while (s.time < 700 && (d.mode === 'hold' || (d.mode === 'relink' && d.relinkAttempt < 3))) {
    ctx.stepSwarm(s, DT);
    if (attempt2At == null && d.mode === 'relink' && d.relinkAttempt === 2) attempt2At = s.time;
  }
  assert.ok(attempt2At != null, 'attempt 2 must start');
  assert.ok(d.mode === 'rtl' || d.relinkAttempt >= 3,
    'stuck in attempt ' + d.relinkAttempt + ' (' + d.mode + ') at t=' + s.time.toFixed(0) + ' s');
  assert.ok(s.time - attempt2At < 300, 'attempt 2 lasted ' + (s.time - attempt2At).toFixed(0) + ' s');
});

function alive(d) { return d.mode !== 'dead' && d.mode !== 'landed'; }
