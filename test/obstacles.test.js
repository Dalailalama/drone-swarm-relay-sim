// Test suite reproducing obstacle bugs (B06, B24, B25).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('reproduction B06: drone must not enter building obstacle cylinder', () => {
  const s = ctx.makeSwarm({
    count: 1,
    airframe: Q450,
    radio: SIK,
    envFactor: 1,
    targetX: 600, targetY: 0,
    altitudeM: 50,
    seed: 42,
  });

  // Add a 100m tall building directly on the path between base (0,0) and target (600,0)
  const b = { x: 300, y: 0, w: 40, d: 40, heightM: 100 };
  s.terrain = ctx.makeTerrain('flat');
  s.terrain.buildings = [b];
  ctx.indexBuildings(s.terrain);

  const d = s.drones[0];
  d.x = 100; d.y = 0; d.vx = 14; d.vy = 0; // flying East toward the building

  const rObst = ctx.buildingObstacleRadiusM(s, b, d.alt); // radius of cylinder

  let minDistance = Infinity;
  for (let i = 0; i < 80; i++) {
    ctx.stepSwarm(s, 0.25);
    const dist = Math.hypot(d.x - b.x, d.y - b.y);
    if (dist < minDistance) minDistance = dist;
  }

  // Drone should never penetrate inside the building footprint
  const bFootprintRadius = Math.hypot(b.w, b.d) / 2;
  assert.ok(minDistance >= bFootprintRadius,
    'drone entered building footprint: min distance ' + minDistance.toFixed(1) + ' m, footprint radius ' + bFootprintRadius.toFixed(1) + ' m');
});

test('reproduction B25: overlapping buildings must return highest roof height', () => {
  const t = ctx.makeTerrain('flat');
  // Two overlapping buildings: one 20m high, one 60m high
  t.buildings = [
    { x: 100, y: 100, w: 50, d: 50, heightM: 20 },
    { x: 100, y: 100, w: 30, d: 30, heightM: 60 },
  ];
  ctx.indexBuildings(t);

  const b = ctx.buildingAt(t, 100, 100);
  assert.ok(b, 'building found');
  assert.strictEqual(b.heightM, 60, 'must return highest roof height, got ' + b.heightM);
});
