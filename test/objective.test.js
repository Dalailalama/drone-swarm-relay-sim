// Finding #6 (review of ffb35e6, B5): `connected` meant "C2 can reach ANY
// mission drone" — with the objective 1,000 km away and the flock still at
// launch, the UI said CONNECTED, uptime accrued, and reports claimed an
// end-to-end objective link. And the objective radius grew with radio range
// (1.5× usable), so a long-range radio called 5 km away "on station".
// `connected` must mean: a live C2 route to a mission drone ON STATION at
// the objective, within an explicit mission radius.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const RFD = R.RADIOS.find(r => r.id === 'rfd900x');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('regression #6: flock at launch with a distant objective is NOT "connected"', () => {
  const s = ctx.makeSwarm({
    count: 4, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 1e6, targetY: 0, altitudeM: 50, seed: 42,
  });
  // Drones sit near base — everyone linked, nobody anywhere near the target.
  const st = ctx.chainStatus(s);
  assert.strictEqual(st.fleetConnected, true, 'fleet link exists near launch');
  assert.strictEqual(st.connected, false,
    'reported an objective link with the objective 1000 km away');
});

test('regression #6: the on-station radius does not grow with radio range', () => {
  const s = ctx.makeSwarm({
    count: 4, airframe: Q450, radio: RFD, envFactor: 1, // ~30 km usable range
    targetX: 20000, targetY: 0, altitudeM: 60, seed: 42,
  });
  // A linked drone 5 km from the objective: within 1.5x radio reach, but in
  // no honest sense "at" the objective.
  const d = s.drones[0];
  d.x = 15000; d.y = 0;
  const st = ctx.chainStatus(s);
  assert.strictEqual(st.connected, false,
    'a drone 5 km short of the objective counted as on station');
});

test('a linked drone on the objective orbit ring IS connected', () => {
  const s = ctx.makeSwarm({
    count: 4, airframe: Q450, radio: RFD, envFactor: 1,
    targetX: 800, targetY: 0, altitudeM: 60, seed: 42,
  });
  const d = s.drones[0];
  d.x = 800 + 60; d.y = 0; // exactly on the orbit ring
  const st = ctx.chainStatus(s);
  assert.strictEqual(st.connected, true, 'on-station linked drone must count');
});

test('regression #6: uptime accrues only while the OBJECTIVE is linked', () => {
  const s = ctx.makeSwarm({
    count: 4, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 1e6, targetY: 0, altitudeM: 50, seed: 42,
  });
  for (let i = 0; i < 20; i++) ctx.stepSwarm(s, 0.25); // 5 s, flock still at launch
  assert.ok(s.stats.connSec < 0.001,
    'en-route time was booked as objective uptime: ' + s.stats.connSec.toFixed(2) + ' s');
});
