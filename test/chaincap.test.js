// Audit C2-01: PLAN.maxSlots = 12 silently capped the chain. A 4 km SiK
// route needs 23 relays; the planner spread 12 across it (308 m hops against
// 211 m usable), kept feasible:true, and the operator warning reported the
// capped count. Audit SCN-03: a route needing more relays than the fleet has
// conscripted every drone, so nothing was left on the mission for the chain
// to connect.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function swarm(count, targetX) {
  return ctx.makeSwarm({ count, airframe: Q450, radio: SIK, envFactor: 1, targetX, targetY: 0, seed: 21 });
}

function hops(s, plan) {
  const nodes = [s.base, ...plan.slots, s.target];
  const out = [];
  for (let i = 0; i < nodes.length - 1; i++) out.push(Math.hypot(nodes[i + 1].x - nodes[i].x, nodes[i + 1].y - nodes[i].y));
  return out;
}

test('C2-01: a fleet big enough for the route gets every relay the route needs, each hop in range', () => {
  const s = swarm(30, 4000);
  const plan = ctx.planChain(s);
  const usable = Math.min(ctx.usableRangeM(SIK, 1), ctx.radioHorizonM(6, s.altitudeM));
  const need = Math.ceil(plan.pathLen / (usable * s.deployFrac)) - 1;
  assert.ok(need > 12, 'scenario must need more than the old 12-slot cap (needs ' + need + ')');
  assert.ok(plan.slots.length >= need, 'planned ' + plan.slots.length + ' of ' + need + ' relays');
  assert.ok(!plan.capped, 'a 30-drone fleet can hold a ' + need + '-relay chain');
  const worst = Math.max(...hops(s, plan));
  assert.ok(worst <= usable, 'hop of ' + worst.toFixed(0) + ' m exceeds usable ' + usable.toFixed(0) + ' m');
});

test('C2-01: a route longer than the fleet can hold is flagged and warned with the true count', () => {
  const s = swarm(6, 4000);
  const plan = ctx.planChain(s);
  assert.strictEqual(plan.capped, true, 'plan must say it cannot close');
  assert.ok(plan.kNeeded >= 23, 'kNeeded ' + plan.kNeeded + ' must be what the route needs');
  assert.ok(plan.slots.length <= 5, 'never more slots than the fleet minus one mission drone');
  const usable = Math.min(ctx.usableRangeM(SIK, 1), ctx.radioHorizonM(6, s.altitudeM));
  // The slots the fleet can fill form a chain that holds from the base out.
  const h = hops(s, plan);
  for (let i = 0; i < h.length - 1; i++) assert.ok(h[i] <= usable, 'hop ' + i + ' of ' + h[i].toFixed(0) + ' m');
  for (let i = 0; i < 12; i++) ctx.stepSwarm(s, 0.25);
  const warn = s.events.find(e => /C2 warning: target needs/.test(e.msg));
  assert.ok(warn, 'C2 must warn that the link cannot close');
  assert.match(warn.msg, /needs (2[3-9]|[3-9]\d) relays/, 'warning must give the route\'s count: ' + warn.msg);
});

test('SCN-03: C2 never makes every flying drone a relay', () => {
  const s = swarm(6, 4000);
  let worst = null;
  while (s.time < 150) {
    ctx.stepSwarm(s, 0.25);
    const flying = s.drones.filter(ctx.alive).length;
    if (s.c2.relays.length >= flying) {
      worst = 't=' + s.time.toFixed(1) + ' relays ' + s.c2.relays.length + '/' + flying;
      break;
    }
  }
  assert.strictEqual(worst, null, 'no mission drone left: ' + worst);
});
