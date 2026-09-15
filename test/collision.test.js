// Finding #1 (review of ffb35e6, B6): a drone must NEVER be inside a no-fly
// building footprint below roof height — at the browser's real timestep.
// The avoidance push is a soft force capped by the accel limit; inertia can
// beat it. These tests pin the hard invariant the soft force can't promise.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function swarmWithBuilding(b) {
  const s = ctx.makeSwarm({
    count: 1, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
  s.terrain = ctx.makeTerrain('flat');
  s.terrain.buildings = [b];
  ctx.indexBuildings(s.terrain);
  return s;
}

function insideFootprint(d, b) {
  return Math.abs(d.x - b.x) < b.w / 2 && Math.abs(d.y - b.y) < b.d / 2;
}

test('regression #1: head-on full-speed approach never enters the footprint at dt=0.05', () => {
  // Reviewer probe: 30x30 m, 100 m tall building at x=100, drone at alt 50
  // closing at max airspeed. Pre-fix it entered at x=85.394 after 0.4 s.
  const b = { x: 100, y: 0, w: 30, d: 30, heightM: 100 };
  const s = swarmWithBuilding(b);
  const d = s.drones[0];
  d.x = 80; d.y = -0.3; d.vx = 14; d.vy = 0; // inside push range, inertia dominant

  for (let i = 0; i < 400; i++) { // 20 s of sim
    ctx.stepSwarm(s, 0.05);
    assert.ok(!insideFootprint(d, b),
      'entered footprint at t=' + (i * 0.05).toFixed(2) + 's, x=' + d.x.toFixed(3) + ', y=' + d.y.toFixed(3));
  }
});

test('regression #1: diagonal corner clip is caught by the sweep, not sampling', () => {
  // Aim the velocity so a straight step would cut across the footprint
  // corner between two samples — only a swept segment check catches this.
  const b = { x: 100, y: 0, w: 30, d: 30, heightM: 100 };
  const s = swarmWithBuilding(b);
  const d = s.drones[0];
  d.x = 82, d.y = -18; d.vx = 10; d.vy = 10;

  for (let i = 0; i < 400; i++) {
    ctx.stepSwarm(s, 0.05);
    assert.ok(!insideFootprint(d, b),
      'corner-clipped into footprint at t=' + (i * 0.05).toFixed(2) + 's, x=' + d.x.toFixed(3) + ', y=' + d.y.toFixed(3));
  }
});

test('regression #1: a drone already inside the clearance band is pushed out, not trapped', () => {
  const b = { x: 100, y: 0, w: 30, d: 30, heightM: 100 };
  const s = swarmWithBuilding(b);
  const d = s.drones[0];
  d.x = 84.2; d.y = 0; d.vx = 2; d.vy = 0; // inside the clearance margin, drifting in

  for (let i = 0; i < 400; i++) ctx.stepSwarm(s, 0.05);
  assert.ok(!insideFootprint(d, b), 'still inside footprint after 20 s: x=' + d.x.toFixed(2));
});

test('buildings at or below flight altitude are overflown, not collided with', () => {
  // A 40 m roof under a 50 m flight level is scenery, not an obstacle: the
  // sweep must NOT block the path or the mission grinds against every
  // low-rise. The drone should cross the footprint line unimpeded.
  const b = { x: 100, y: 0, w: 30, d: 30, heightM: 40 };
  const s = swarmWithBuilding(b);
  const d = s.drones[0];
  d.x = 80; d.y = 0; d.vx = 14; d.vy = 0;

  let crossed = false;
  for (let i = 0; i < 400; i++) {
    ctx.stepSwarm(s, 0.05);
    if (d.x > 120) { crossed = true; break; }
  }
  assert.ok(crossed, 'drone never crossed a low building it should overfly (x=' + d.x.toFixed(1) + ')');
});
