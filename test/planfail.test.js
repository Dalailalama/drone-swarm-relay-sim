// Finding #19 (review of ffb35e6, B27): when A* found NO route, planChain
// fell back to the straight line and still placed relay slots along it —
// straight through the blockage — with feasible:false that no consumer read.
// A failed search must produce NO slots, and C2 must say so out loud.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function wallSwarm() {
  const s = ctx.makeSwarm({
    count: 6, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
  // A continuous 200 m-thick, 500 m-tall building wall crossing the entire
  // search box between base and target: no route exists, full stop.
  s.terrain = ctx.makeTerrain('flat');
  const wall = [];
  for (let y = -4000; y <= 4000; y += 180) {
    wall.push({ x: 300, y, w: 220, d: 200, heightM: 500 });
  }
  s.terrain.buildings = wall;
  ctx.indexBuildings(s.terrain);
  return s;
}

test('regression #19: an unroutable corridor yields NO relay slots', () => {
  const s = wallSwarm();
  const plan = ctx.planChain(s);
  assert.strictEqual(plan.feasible, false, 'wall must make the plan infeasible');
  assert.strictEqual(plan.slots.length, 0,
    'infeasible plan still assigned ' + plan.slots.length + ' slots (through the wall)');
});

test('regression #19: C2 logs an explicit no-route failure', () => {
  const s = wallSwarm();
  for (let i = 0; i < 40; i++) ctx.stepSwarm(s, 0.25); // let C2 plan and speak
  const said = s.events.some(e => e.kind === 'error' && /no feasible route|route.*blocked|corridor blocked/i.test(e.msg));
  assert.ok(said, 'C2 must announce the plan cannot close; events: ' +
    s.events.slice(-5).map(e => e.msg).join(' | '));
});

test('a routable corridor still plans slots (guard)', () => {
  const s = ctx.makeSwarm({
    count: 6, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
  const plan = ctx.planChain(s);
  assert.strictEqual(plan.feasible, true);
  assert.ok(plan.slots.length >= 1, 'open corridor must place relay slots');
});
