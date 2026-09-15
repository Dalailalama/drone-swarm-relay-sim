// Finding #18 (review of ffb35e6, B19): onboard decisions and logs read
// LIVE truth the vehicle cannot know —
//  * GPS-denied black-box samples recorded ~the TRUE position (reviewer:
//    belief (1000,1000), truth (100,100), logged (99.59, 97.24));
//  * return/relink goals aimed at the CURRENT base position even while
//    fully disconnected — teleport the operator and a link-dead drone
//    magically follows.
// Drones log their nav BELIEF, and steer home to where they last LEARNED
// the base was (spawn briefing, updated by every received C2 packet).
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

test('regression #18: GPS-denied black-box samples record the BELIEF, not truth', () => {
  const s = mk();
  const d = s.drones[0];
  d.gpsDenied = true;
  d.belX = 1000; d.belY = 1000; // dead-reckoning estimate, far from truth
  d.x = 100; d.y = 100;
  d.mode = 'hold';
  d.nextDeadLog = 0;
  ctx.stepSwarm(s, 0.05);
  assert.ok(d.deadLog.length >= 1, 'a silent drone must log');
  const p = d.deadLog[d.deadLog.length - 1];
  const toBelief = Math.hypot(p.x - 1000, p.y - 1000);
  const toTruth = Math.hypot(p.x - 100, p.y - 100);
  assert.ok(toBelief < 60 && toTruth > 500,
    'black box recorded (' + p.x.toFixed(1) + ', ' + p.y.toFixed(1) + ') — the truth it cannot know');
});

test('regression #18: a returning drone flies to where it LAST KNEW the base', () => {
  const s = mk();
  const d = s.drones[0];
  d.x = 600; d.y = 0; d.vx = 0; d.vy = 0;
  d.mode = 'rtb'; // returning — and by design not processing comms
  s.base.x = 0; s.base.y = 5000; // operator teleports while the drone is deaf
  for (let i = 0; i < 40; i++) ctx.stepSwarm(s, 0.05);
  assert.ok(Math.abs(d.goalY) < 500,
    'a drone that never heard about the move steered to the new base anyway (goalY=' +
    (d.goalY == null ? 'null' : d.goalY.toFixed(0)) + ')');
});

test('a received C2 packet teaches the drone the new base position (guard)', () => {
  const s = mk();
  const d = s.drones[0];
  // Within link range of the relocated base, so the tether doesn't fight
  // the return leg — this guard tests the KNOWLEDGE, not tether physics.
  d.x = 0; d.y = 4800;
  s.base.x = 0; s.base.y = 5000;
  // A broadcast physically arrives carrying C2's position…
  d.inbox.push({ kind: 'bcast', src: 'C2', payload: { seq: 99, orders: {}, c2: { x: 0, y: 5000 } } });
  ctx.stepSwarm(s, 0.05);
  assert.ok(d.baseKnown && Math.abs(d.baseKnown.y - 5000) < 1,
    'the packet must update the drone\'s base knowledge');
  // …and a subsequent return flies to the LEARNED position.
  d.mode = 'rtb';
  for (let i = 0; i < 10; i++) ctx.stepSwarm(s, 0.05);
  assert.ok(d.goalY > 3000,
    'after hearing from C2, home is the real base (goalY=' + (d.goalY == null ? 'null' : d.goalY.toFixed(0)) + ')');
});
