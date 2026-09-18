// Test suite reproducing obstacle bugs (B06, B24, B25).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('F06: a single outgoing leg cannot cross an indexed tower beyond 600 m', () => {
  const { loadUI } = require('./helpers/dom.js');
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const d = s.drones[0];
  ui.ctx.externalConnect(() => s, 'ws://test:1', s.drones.length, 60);
  const ws = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ type: 'ready', ids: [d.id], vehicles: [{ id: d.id, ready: true, state: 'ready' }] }) });
  ws.onmessage({ data: JSON.stringify({ type: 'telemetry', vehicles: [{
    id: d.id, ready: true, state: 'ready', armed: true, connected: true,
    x: 0, y: 0, alt: 60, positionSeq: 1, positionAge: 0, heartbeatAge: 0,
  }] }) });
  s.terrain = ctx.makeTerrain('flat');
  const b = { x: 1000, y: 0, w: 60, d: 60, heightM: 300 };
  s.terrain.buildings = [b];
  ctx.indexBuildings(s.terrain);
  d.x = 0; d.y = 0; d.goalX = 2000; d.goalY = 0;
  s.time = 1;
  ui.ctx.externalPushGoals(s);
  const msgs = ws.sent.map(m => JSON.parse(m)).filter(m => m.type === 'goals');
  const g = msgs.at(-1).goals.find(g => g.id === d.id);
  assert.ok(g, 'the actual bridge command must be inspected');
  assert.strictEqual(ctx.rayIntersectsAABB(0, 0, g.x, g.y, 967.5, 1032.5, -32.5, 32.5), null);
});

test('F06: capped and short legs still stop before the first indexed footprint', () => {
  const terrain = ctx.makeTerrain('flat');
  terrain.buildings = [{ x: 300, y: 0, w: 60, d: 60, heightM: 300 }];
  ctx.indexBuildings(terrain);
  const s = { terrain, altitudeM: 50 };
  for (const x of [400, 2000]) {
    const g = ctx.clipGoalToNoFly(s, { x: 0, y: 0 }, { x, y: 0 });
    assert.ok(g.x > 0 && g.x < 267.5);
    assert.strictEqual(ctx.rayIntersectsAABB(0, 0, g.x, g.y, 267.5, 332.5, -32.5, 32.5), null);
  }
  const clear = ctx.clipGoalToNoFly(s, { x: 0, y: 200 }, { x: 2000, y: 200 });
  assert.strictEqual(clear.x, 557.5);
  assert.strictEqual(ctx.clipGoalToNoFly(s, { x: 0, y: 200 }, { x: 100, y: 200 }).x, 100);
});

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
