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
  const ids = ui.ctx.sim.swarm.drones.map(d => d.id);
  const vehicles = ids.map(id => ({ id, ready: true, state: 'ready' }));
  ws.onmessage({ data: JSON.stringify({ type: 'ready', ids, vehicles }) });
  return ws;
}

function telem(ws, t, vehicles) {
  ws.onmessage({ data: JSON.stringify({ type: 'telemetry', t, vehicles: vehicles.map(v => ({
    ready: true, state: 'ready', armed: true, positionSeq: 1 + (v.__seq || 0), positionAge: 0,
    ...v, __seq: undefined })) }) });
}

test('F04: a stale or late-arriving landed claim never authorizes a swap', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connectBridge(ui);
  const d = s.drones[0];
  d.mode = 'rtb';
  telem(ws, 1, [{ id: d.id, x: 2, y: 0, alt: 50, connected: true }]);
  s.time += 1;
  ui.ctx.stepSwarm(s, 0.25);
  ui.ctx.externalPushGoals(s);
  const land = ws.sent.map(m => JSON.parse(m)).find(m => m.type === 'service' && m.action === 'land');
  assert.ok(land, 'land service requested');
  ui.ctx.__clock.ms += 30000;
  s.time += 30;
  telem(ws, 31, [{ id: d.id, x: 2, y: 0, alt: 0.5, connected: true, armed: false, landed: true,
    landedSeq: 1, landedAge: 29, state: 'landed', ready: false, servicePhase: 'landing',
    serviceId: land.requestId, heartbeatAge: 29 }]);
  ui.ctx.stepSwarm(s, 0.25);
  assert.ok(!ws.sent.map(m => JSON.parse(m)).some(m => m.type === 'service' && m.action === 'authorize'),
    'a 29 s-old landed claim must not authorize a battery swap');
  assert.notStrictEqual(d.mode, 'landed');
  assert.ok(!d.swapAt, 'no swap scheduled from stale ground evidence');
});

test('regression #11: an external RTB drone is not "landed" while still at altitude', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connectBridge(ui);
  const d = s.drones[0];
  d.mode = 'rtb';
  // Vehicle hovers over the pad at 50 m — the reviewer's probe.
  telem(ws, 1, [{ id: d.id, x: 2, y: 0, alt: 50, connected: true }]);
  s.time += 1;
  ui.ctx.externalPushGoals(s);
  for (let i = 0; i < 8; i++) ui.ctx.stepSwarm(s, 0.25);
  assert.notStrictEqual(d.mode, 'landed',
    'airborne vehicle (50 m) was marked landed and queued for a battery swap');
  assert.ok(!d.swapAt, 'no ground-crew swap for a flying vehicle');
  const land = ws.sent.map(m => JSON.parse(m)).find(m => m.type === 'service' && m.action === 'land');
  assert.ok(land, 'landing is commanded through the explicit land service');
  assert.strictEqual(d.mode, 'rtb', 'touchdown confirmation owns the landing');
  telem(ws, 2, [{ id: d.id, x: 2, y: 0, alt: 0.5, connected: true, armed: true, landed: false,
    landedSeq: 0, landedAge: null, state: 'landing', ready: false, servicePhase: 'landing',
    serviceId: land.requestId, heartbeatAge: 0 }]);
  ui.ctx.stepSwarm(s, 0.25);
  assert.strictEqual(d.mode, 'rtb', 'disarmed/landed evidence is required before any swap');
  telem(ws, 3, [{ id: d.id, x: 2, y: 0, alt: 0.5, connected: true, armed: false, landed: true,
    landedSeq: 1, landedAge: 0.1, state: 'landed', ready: false, servicePhase: 'landing',
    serviceId: land.requestId, heartbeatAge: 0 }]);
  ui.ctx.stepSwarm(s, 0.25);
  const authorize = ws.sent.map(m => JSON.parse(m)).filter(m => m.type === 'service' && m.action === 'authorize');
  assert.ok(authorize.length >= 1, 'confirmed touchdown must request the swap authorization');
  telem(ws, 4, [{ id: d.id, x: 2, y: 0, alt: 0.5, connected: true, armed: false, landed: true,
    landedSeq: 1, landedAge: 0.1, state: 'swapping', ready: false, servicePhase: 'swapping',
    serviceId: land.requestId, heartbeatAge: 0 }]);
  ui.ctx.stepSwarm(s, 0.25);
  assert.strictEqual(d.mode, 'landed', 'a swap-authorized, grounded vehicle is landed');
  assert.ok(d.swapAt, 'swap scheduled after REAL touchdown + authorization');
  assert.ok(!ws.sent.map(m => JSON.parse(m)).some(m => m.type === 'service' && m.action === 'complete'),
    'no swap completion before the ground-crew timer');
  s.time = d.swapAt + 0.1;
  ui.ctx.stepSwarm(s, 0.25);
  assert.strictEqual(ws.sent.map(m => JSON.parse(m)).filter(m => m.type === 'service' && m.action === 'complete').length, 1,
    'swap completion is requested exactly once, after the timer');
  telem(ws, 5, [{ id: d.id, x: 2, y: 0, alt: 0.5, connected: true, armed: false, landed: true,
    landedSeq: 2, landedAge: 0, positionSeq: 2, state: 'swapped', ready: false,
    servicePhase: 'swapped', serviceId: land.requestId, heartbeatAge: 0 }]);
  ui.ctx.stepSwarm(s, 0.25);
  const relaunches = () => ws.sent.map(JSON.parse).filter(m => m.type === 'service' && m.action === 'relaunch');
  assert.strictEqual(relaunches().length, 1);
  telem(ws, 6, [{ id: d.id, x: 2, y: 0, alt: 0.5, connected: true, armed: false,
    positionSeq: 3, ready: false, state: 'failed:arm', servicePhase: 'relaunch', serviceId: land.requestId }]);
  ui.ctx.stepSwarm(s, 0.5);
  assert.strictEqual(d.mode, 'landed');
  assert.strictEqual(s.stats.swaps || 0, 0);
  assert.strictEqual(relaunches().length, 1);
  telem(ws, 7, [{ id: d.id, x: 2, y: 0, alt: 60, connected: true,
    positionSeq: 4, servicePhase: null, serviceId: land.requestId }]);
  ui.ctx.stepSwarm(s, 0.5);
  assert.strictEqual(d.mode, 'ok');
  assert.strictEqual(s.stats.swaps, 1);
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id], undefined);
  assert.ok(ws.sent.map(JSON.parse).filter(m => m.type === 'goals').at(-1).goals.some(g => g.id === d.id));
  d.mode = 'rtb';
  ui.ctx.stepSwarm(s, 0.5);
  const lands = ws.sent.map(JSON.parse).filter(m => m.type === 'service' && m.action === 'land');
  assert.strictEqual(lands.length, 2);
  assert.notStrictEqual(lands[1].requestId, land.requestId);
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
  const svcMsgs = ws.sent.map(m => JSON.parse(m)).filter(m => m.type === 'service');
  const land = svcMsgs.find(m => m.action === 'land');
  assert.ok(land, 'an RTB-over-pad drone must be commanded to land, not hover forever');
  const goalMsgs = ws.sent.map(m => JSON.parse(m)).filter(m => m.type === 'goals');
  const last = goalMsgs[goalMsgs.length - 1];
  const g = last && last.goals.find(x => x.id === d.id);
  assert.ok(!g, 'no cruising goal may compete with the landing command');
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
