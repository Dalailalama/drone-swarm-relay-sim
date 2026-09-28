// #13: drones froze against building walls and corners at full speed.
// clampStepToBuildings cut the WHOLE step at the first wall hit, backed off by
// a fraction of the step (so the drone ended ~1e-7 m off the face), and kept
// no motion for the rest of the step. The goal term re-adds a little inward
// velocity every tick, so every later step hit at t~0: zero motion forever
// while |v| read 9-14 m/s and the battery drained at cruise power. At corners
// the "nearest face to the entry point" pick could land on the face PARALLEL
// to the motion, so the velocity into the building was never cancelled.

const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const ctx = loadCore();
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');
const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const CLEAR = ctx.consts ? ctx.consts.OBSTACLE_CLEAR_M : 2.5;

function swarmWithBuilding(b) {
  const s = ctx.makeSwarm({ count: 1, airframe: Q450, radio: SIK, envFactor: 1, targetX: 600, targetY: 0, altitudeM: 50, seed: 42 });
  s.terrain = ctx.makeTerrain('flat');
  s.terrain.buildings = [b];
  ctx.indexBuildings(s.terrain);
  return s;
}

test('#13: a drone pressed against a wall slides along it instead of freezing', () => {
  const b = { x: 100, y: 0, w: 30, d: 400, heightM: 100 };
  const s = swarmWithBuilding(b);
  const d = s.drones[0];
  const faceX = b.x - b.w / 2 - (CLEAR || 2.5);
  d.x = faceX - 1e-7; d.y = -150; // parked a hair off the inflated face
  const y0 = d.y;
  for (let i = 0; i < 200; i++) { // 10 s
    d.vx = 0.2; d.vy = 9;         // goal-seeking keeps a small inward component
    ctx.clampStepToBuildings(s, d, 0.05);
    assert.ok(d.x <= faceX + 1e-9, `entered the clearance band at tick ${i}: x=${d.x}`);
  }
  const slid = d.y - y0;
  assert.ok(slid >= 85, `slid only ${slid.toFixed(3)} m of the 90 m the tangential velocity allows`);
});

test('#13: relays that rammed building corners are not frozen at speed (DDIL-style urban config)', () => {
  // Seeded, schema-valid config from the soak audit (wedge scan #70011): wind 0.
  const tx = -2298.4, ty = -3273.7, seed = 573976;
  const zones = [{ id: 'FZ0', x: tx, y: ty, rM: 766, on: true }, { id: 'FZ1', x: -1564.5, y: -3954.3, rM: 1329, on: true },
    { id: 'FZ2', x: tx, y: ty, rM: 214, on: true }];
  const s = ctx.makeSwarm({
    count: 8, airframe: Q450, radio: R.RADIOS.find(r => r.id === 'silvus-sc4400'), envFactor: 1, shadowSigmaDb: 2.5,
    altitudeM: 68, deployFrac: 0.71, targetX: tx, targetY: ty, seed,
    terrain: ctx.makeTerrain('urban', { distM: Math.hypot(tx, ty), altM: 68, targetX: tx, targetY: ty, seed, density: 0.81, heightScale: 0.58 }),
    videoOn: true, videoKbps: 2000, adversaryMode: true, relayWing: 1,
    relayAirframe: A.AIRFRAMES.find(a => a.id === 'micro'), relayRadio: R.RADIOS.find(r => r.id === 'rajant-es1'),
    gpsZones: zones, broadcastC2: false,
  });
  while (s.time < 110) ctx.stepSwarm(s, 0.05);
  const snap = s.drones.map(d => ({ d, x: d.x, y: d.y }));
  while (s.time < 170) ctx.stepSwarm(s, 0.05);
  const frozen = snap.filter(({ d, x, y }) =>
    ctx.alive(d) && Math.hypot(d.x - x, d.y - y) < 0.05 && Math.hypot(d.vx, d.vy) > 1)
    .map(({ d }) => `${d.id} ${Math.hypot(d.vx, d.vy).toFixed(1)} m/s`);
  // (the list comes from the sim's vm realm, so compare its length, not deepEqual)
  assert.strictEqual(frozen.length, 0, 'drones sat still for 60 s while flying at speed: ' + frozen.join(', '));
});
