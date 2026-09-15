// Finding #11 (review of ffb35e6, B47/B48): obstacle avoidance lives in the
// INTERNAL physics branch, after the outgoing goal is cached — external
// vehicles were shipped raw straight-line goals through no-fly towers. And
// an external RTB drone was marked landed (battery swap scheduled) while
// its reported altitude was still 50 m. Goals must be vetted against the
// obstacle map before shipping; landing must be CONFIRMED by telemetry.
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { loadUI } = require('./helpers/dom.js');

function connectBridge(ui) {
  const s = () => ui.ctx.sim.swarm;
  ui.ctx.externalConnect(s, 'ws://test:1', ui.ctx.sim.swarm.drones.length, 60);
  const ws = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  ws.onopen();
  ws.onmessage({ data: JSON.stringify({ type: 'ready', ids: ui.ctx.sim.swarm.drones.map(d => d.id) }) });
  return ws;
}

function telem(ws, t, vehicles) {
  ws.onmessage({ data: JSON.stringify({ type: 'telemetry', t, vehicles }) });
}

test('regression #11: an external RTB drone is not "landed" while still at altitude', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connectBridge(ui);
  const d = s.drones[0];
  d.mode = 'rtb';
  // Vehicle hovers over the pad at 50 m — the reviewer's probe.
  telem(ws, 1, [{ id: d.id, x: 2, y: 0, alt: 50, connected: true }]);
  for (let i = 0; i < 8; i++) ui.ctx.stepSwarm(s, 0.25);
  assert.notStrictEqual(d.mode, 'landed',
    'airborne vehicle (50 m) was marked landed and queued for a battery swap');
  assert.ok(!d.swapAt, 'no ground-crew swap for a flying vehicle');
  // Now the vehicle actually touches down.
  telem(ws, 3, [{ id: d.id, x: 2, y: 0, alt: 0.5, connected: true }]);
  for (let i = 0; i < 8; i++) ui.ctx.stepSwarm(s, 0.25);
  assert.strictEqual(d.mode, 'landed', 'confirmed touchdown must land');
  assert.ok(d.swapAt, 'swap scheduled after REAL touchdown');
});

test('regression #11: an RTB external drone is told to descend, not hover forever', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connectBridge(ui);
  const d = s.drones[0];
  d.mode = 'rtb';
  telem(ws, 1, [{ id: d.id, x: 2, y: 0, alt: 50, connected: true }]);
  s.time += 1; // let the 2 Hz goal throttle pass
  ui.ctx.stepSwarm(s, 0.25);
  ui.ctx.externalPushGoals(s);
  const goalMsgs = ws.sent.map(m => JSON.parse(m)).filter(m => m.type === 'goals');
  const last = goalMsgs[goalMsgs.length - 1];
  const g = last && last.goals.find(x => x.id === d.id);
  assert.ok(g, 'a goal must be shipped for the RTB drone');
  assert.ok(g.alt <= 2, 'RTB-over-pad goal must command descent, got alt ' + (g && g.alt));
});

test('regression #11: shipped goals are pulled short of no-fly buildings', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connectBridge(ui);
  // A 300 m tower squarely between the drone and its goal.
  const T = vm.runInContext('({ makeTerrain, indexBuildings, rayIntersectsAABB })', ui.ctx);
  s.terrain = T.makeTerrain('flat');
  const b = { x: 200, y: 0, w: 60, d: 60, heightM: 300 };
  s.terrain.buildings = [b];
  T.indexBuildings(s.terrain);
  const d = s.drones[0];
  telem(ws, 1, [{ id: d.id, x: 40, y: 0, alt: 60, connected: true }]);
  d.x = 40; d.y = 0;
  d.goalX = 400; d.goalY = 0; // straight through the tower
  s.time += 1;
  ui.ctx.externalPushGoals(s);
  const goalMsgs = ws.sent.map(m => JSON.parse(m)).filter(m => m.type === 'goals');
  const g = goalMsgs[goalMsgs.length - 1].goals.find(x => x.id === d.id);
  assert.ok(g, 'goal shipped');
  const crosses = T.rayIntersectsAABB(d.x, d.y, g.x, g.y,
    b.x - b.w / 2, b.x + b.w / 2, b.y - b.d / 2, b.y + b.d / 2);
  assert.ok(!crosses || crosses.tmin >= 1,
    'shipped goal sends the vehicle straight through a 300 m tower (goal x=' + g.x.toFixed(0) + ')');
});
