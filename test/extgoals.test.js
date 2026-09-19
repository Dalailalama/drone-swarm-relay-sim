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

test('C05 / W02: service request retries on transient rejection, enforces 0.5s throttle, preserves failure against telemetry, and fails on ACK exhaustion', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connectBridge(ui);
  const d = s.drones[0];
  d.mode = 'rtb';
  telem(ws, 1, [{ id: d.id, x: 2, y: 0, alt: 50, connected: true }]);
  s.time += 1;
  ui.ctx.stepSwarm(s, 0.25);
  ui.ctx.externalPushGoals(s);

  const landMsgs = () => ws.sent.map(JSON.parse).filter(m => m.type === 'service' && m.action === 'land');
  assert.strictEqual(landMsgs().length, 1);
  const reqId = landMsgs()[0].requestId;

  // Transient rejection with retryable: true
  ws.onmessage({ data: JSON.stringify({
    type: 'service_ack', requestId: reqId, id: d.id, action: 'land',
    accepted: false, code: 'VEHICLE_NOT_READY', retryable: true,
  }) });

  const svc = ui.ctx.ExternalMode.services[d.id];
  assert.strictEqual(svc.retries, 1);

  // Probe 1: immediate tick (wallMs=0 elapsed) must NOT send
  ui.ctx.externalPushGoals(s);
  assert.strictEqual(landMsgs().length, 1, 'must not retry with 0 elapsed time');

  // Advance clock by 400ms (elapsed = 0.4 < 0.5)
  ui.ctx.__clock.ms += 400;
  s.time += 0.4;
  ui.ctx.externalPushGoals(s);
  assert.strictEqual(landMsgs().length, 1, 'must not retry before 0.5s throttle interval');

  // Advance clock past throttle (total elapsed = 600ms >= 0.5s)
  ui.ctx.__clock.ms += 200;
  s.time += 0.2;
  ui.ctx.externalPushGoals(s);
  assert.strictEqual(landMsgs().length, 2, 'transient rejection must be retried after 0.5s');
  assert.strictEqual(svc.retries, 2);

  // Probe 2: Non-retryable rejection makes failure terminal
  ws.onmessage({ data: JSON.stringify({
    type: 'service_ack', requestId: reqId, id: d.id, action: 'land',
    accepted: false, code: 'PERMANENT_ERROR', retryable: false,
  }) });
  assert.strictEqual(svc.phase, 'failed');

  // Routine telemetry must NOT overwrite terminal failure
  telem(ws, s.time, [{ id: d.id, x: 2, y: 0, alt: 50, connected: true, serviceId: reqId, servicePhase: 'landing', state: 'landing' }]);
  assert.strictEqual(svc.phase, 'failed', 'routine telemetry must not revive failed service');

  // Next ticks must NOT retry
  ui.ctx.__clock.ms += 1000;
  s.time += 1.0;
  ui.ctx.externalPushGoals(s);
  assert.strictEqual(landMsgs().length, 2, 'permanent rejection must not be retried');

  // Probe 3: Missing-ACK exhaustion for complete/relaunch
  const d2 = s.drones[1];
  d2.mode = 'landed';
  const reqId2 = 'test-exhaust-svc';
  ui.ctx.ExternalMode.services[d2.id] = { id: reqId2, phase: 'swapping', retries: 0 };
  const completeMsgs = () => ws.sent.map(JSON.parse).filter(m => m.type === 'service' && m.action === 'complete' && m.id === d2.id);

  // Send 1 to 5 spaced 0.6s apart without ACKs
  for (let i = 1; i <= 5; i++) {
    ui.ctx.__clock.ms += 600;
    s.time += 0.6;
    telem(ws, s.time, [{ id: d2.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true, landedSeq: i, landedAge: 0, heartbeatAge: 0, __seq: i, state: 'swapping', serviceId: reqId2 }]);
    ui.ctx.externalServiceComplete(s, d2);
    assert.strictEqual(completeMsgs().length, i, 'expected send ' + i);
  }

  // 6th check after 0.6s: retries exhausted -> transitions to failed
  ui.ctx.__clock.ms += 600;
  s.time += 0.6;
  telem(ws, s.time, [{ id: d2.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true, landedSeq: 6, landedAge: 0, heartbeatAge: 0, __seq: 6, state: 'swapping', serviceId: reqId2 }]);
  ui.ctx.externalServiceComplete(s, d2);
  assert.strictEqual(completeMsgs().length, 5, 'must not send after retries exhausted');
  assert.strictEqual(ui.ctx.ExternalMode.services[d2.id].phase, 'failed');
  assert.ok(ui.ctx.ExternalMode.status.includes('failed: retries exhausted'));
});

test('C06 / W06: full external RTL lifecycle: landing -> C2 reconnection -> grounded -> swap -> relaunch', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connectBridge(ui);
  const d = s.drones[0];
  d.mode = 'rtl';
  telem(ws, 1, [{ id: d.id, x: 2, y: 0, alt: 50, connected: true }]);
  s.time += 1;
  ui.ctx.stepSwarm(s, 0.25);
  ui.ctx.externalPushGoals(s);

  const landCmd = ws.sent.map(JSON.parse).find(m => m.type === 'service' && m.action === 'land' && m.id === d.id);
  assert.ok(landCmd, 'external RTL drone over pad must command land service');
  const reqId = landCmd.requestId;
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id].phase, 'landing');

  // C2 packet with orders arrives during descent: must NOT clobber d.mode to 'ok'
  d.inbox.push({
    kind: 'bcast',
    payload: {
      c2: { x: 0, y: 0, at: s.time },
      orders: { [d.id]: { role: 'mission', target: s.target, upstream: 'C2', upstreamPos: { x: 0, y: 0, at: s.time } } },
    },
  });
  ui.ctx.stepSwarm(s, 0.25);
  assert.strictEqual(d.mode, 'rtl', 'active landing service must prevent C2 orders from changing mode to ok');

  // Touchdown telemetry arrives (state='landed')
  ws.onmessage({ data: JSON.stringify({ type: 'service_ack', id: d.id, requestId: reqId, action: 'land', accepted: true }) });
  telem(ws, s.time, [{
    id: d.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true,
    landedSeq: 1, landedAge: 0, heartbeatAge: 0, state: 'landed', ready: false, servicePhase: 'landed', serviceId: reqId,
  }]);
  ui.ctx.stepSwarm(s, 0.25);

  // Authorize swap requested
  const authCmd = ws.sent.map(JSON.parse).find(m => m.type === 'service' && m.action === 'authorize' && m.id === d.id);
  assert.ok(authCmd, 'authorize commanded');
  ws.onmessage({ data: JSON.stringify({ type: 'service_ack', id: d.id, requestId: reqId, action: 'authorize', accepted: true }) });
  telem(ws, s.time, [{
    id: d.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true,
    landedSeq: 2, landedAge: 0, heartbeatAge: 0, state: 'swapping', ready: false, servicePhase: 'swapping', serviceId: reqId,
  }]);
  ui.ctx.stepSwarm(s, 0.25);

  // Once in swapping state, drone marks landed and schedules swap
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id].phase, 'swapping');
  assert.strictEqual(d.mode, 'landed');
  assert.ok(d.swapAt > s.time, 'battery swap scheduled');

  // Advance past swap duration (90s)
  ui.ctx.__clock.ms += 95000;
  s.time += 95;
  telem(ws, s.time, [{
    id: d.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true,
    landedSeq: 4, landedAge: 0, heartbeatAge: 0, __seq: 2, state: 'swapping', ready: false, servicePhase: 'swapping', serviceId: reqId,
  }]);
  ui.ctx.stepSwarm(s, 0.25);

  // Complete commanded
  const compCmd = ws.sent.map(JSON.parse).find(m => m.type === 'service' && m.action === 'complete' && m.id === d.id);
  assert.ok(compCmd, 'complete commanded');
  ws.onmessage({ data: JSON.stringify({ type: 'service_ack', id: d.id, requestId: reqId, action: 'complete', accepted: true }) });
  telem(ws, s.time, [{
    id: d.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true,
    landedSeq: 5, landedAge: 0, heartbeatAge: 0, __seq: 3, state: 'swapped', ready: false, servicePhase: 'swapped', serviceId: reqId,
  }]);
  ui.ctx.stepSwarm(s, 0.25);

  // Relaunch commanded
  const relCmd = ws.sent.map(JSON.parse).find(m => m.type === 'service' && m.action === 'relaunch' && m.id === d.id);
  assert.ok(relCmd, 'relaunch commanded');
  ws.onmessage({ data: JSON.stringify({ type: 'service_ack', id: d.id, requestId: reqId, action: 'relaunch', accepted: true }) });
  telem(ws, s.time, [{
    id: d.id, x: 0, y: 0, alt: 50, connected: true, armed: true, landed: false,
    landedAge: null, heartbeatAge: 0, __seq: 4, state: 'ready', ready: true, servicePhase: null, serviceId: reqId,
  }]);
  ui.ctx.stepSwarm(s, 0.25);

  // Handshake complete: service record deleted, mode transitions back to ok
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id], undefined);
  assert.strictEqual(d.mode, 'ok', 'drone must be back in ok mode');
  assert.ok(d.batteryPct >= 99, 'battery must be fresh after swap');
  if (s.stats) assert.strictEqual(s.stats.swaps, 1, 'one swap must be recorded');
  assert.strictEqual(d.swapAt, null);
});

test('W09: RTL battery swap cycle with telemetry gap during swap', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connectBridge(ui);
  const d = s.drones[0];
  d.mode = 'rtl';
  telem(ws, 1, [{ id: d.id, x: 2, y: 0, alt: 50, connected: true }]);
  s.time += 1;
  ui.ctx.stepSwarm(s, 0.25);
  ui.ctx.externalPushGoals(s);

  const landCmd = ws.sent.map(JSON.parse).find(m => m.type === 'service' && m.action === 'land' && m.id === d.id);
  assert.ok(landCmd, 'external RTL drone over pad must command land service');
  const reqId = landCmd.requestId;
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id].phase, 'landing');

  // Touchdown telemetry arrives (state='landed')
  ws.onmessage({ data: JSON.stringify({ type: 'service_ack', id: d.id, requestId: reqId, action: 'land', accepted: true }) });
  telem(ws, s.time, [{
    id: d.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true,
    landedSeq: 1, landedAge: 0, heartbeatAge: 0, state: 'landed', ready: false, servicePhase: 'landed', serviceId: reqId,
  }]);
  ui.ctx.stepSwarm(s, 0.25);

  // Authorize swap requested
  const authCmd = ws.sent.map(JSON.parse).find(m => m.type === 'service' && m.action === 'authorize' && m.id === d.id);
  assert.ok(authCmd, 'authorize commanded');
  ws.onmessage({ data: JSON.stringify({ type: 'service_ack', id: d.id, requestId: reqId, action: 'authorize', accepted: true }) });
  telem(ws, s.time, [{
    id: d.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true,
    landedSeq: 2, landedAge: 0, heartbeatAge: 0, state: 'swapping', ready: false, servicePhase: 'swapping', serviceId: reqId,
  }]);
  ui.ctx.stepSwarm(s, 0.25);

  // Once in swapping state, drone marks landed and schedules swap
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id].phase, 'swapping');
  assert.strictEqual(d.mode, 'landed');
  const initialSwapAt = d.swapAt;
  assert.ok(initialSwapAt > s.time, 'battery swap scheduled');

  // Brief telemetry interruption (4s gap > EXT_STALE_SEC)
  ui.ctx.__clock.ms += 4000;
  s.time += 4;
  ui.ctx.externalPullPositions(s);
  assert.strictEqual(d.mode, 'landed', 'telemetry gap must not mark grounded drone dead or change mode');

  // Telemetry returns with advancing sequence number
  ui.ctx.__clock.ms += 100;
  s.time += 0.1;
  telem(ws, s.time, [{
    id: d.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true,
    landedSeq: 3, landedAge: 0, heartbeatAge: 0, __seq: 1, state: 'swapping', ready: false,
    servicePhase: 'swapping', serviceId: reqId,
  }]);
  ui.ctx.externalPullPositions(s);
  assert.strictEqual(d.mode, 'landed', 'fresh telemetry after gap must keep grounded drone in landed mode');
  assert.strictEqual(d.swapAt, initialSwapAt, 'swap timer must be preserved across telemetry gap');
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id].phase, 'swapping');

  // Advance past swap duration (90s)
  ui.ctx.__clock.ms += 95000;
  s.time += 95;
  telem(ws, s.time, [{
    id: d.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true,
    landedSeq: 4, landedAge: 0, heartbeatAge: 0, __seq: 2, state: 'swapping', ready: false, servicePhase: 'swapping', serviceId: reqId,
  }]);
  ui.ctx.stepSwarm(s, 0.25);

  // Complete commanded
  const compCmd = ws.sent.map(JSON.parse).find(m => m.type === 'service' && m.action === 'complete' && m.id === d.id);
  assert.ok(compCmd, 'complete commanded after swap duration');
  ws.onmessage({ data: JSON.stringify({ type: 'service_ack', id: d.id, requestId: reqId, action: 'complete', accepted: true }) });
  telem(ws, s.time, [{
    id: d.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true,
    landedSeq: 5, landedAge: 0, heartbeatAge: 0, __seq: 3, state: 'swapped', ready: false, servicePhase: 'swapped', serviceId: reqId,
  }]);
  ui.ctx.stepSwarm(s, 0.25);

  // Relaunch commanded
  const relCmd = ws.sent.map(JSON.parse).find(m => m.type === 'service' && m.action === 'relaunch' && m.id === d.id);
  assert.ok(relCmd, 'relaunch commanded');
  ws.onmessage({ data: JSON.stringify({ type: 'service_ack', id: d.id, requestId: reqId, action: 'relaunch', accepted: true }) });
  telem(ws, s.time, [{
    id: d.id, x: 0, y: 0, alt: 50, connected: true, armed: true, landed: false,
    landedAge: null, heartbeatAge: 0, __seq: 4, state: 'ready', ready: true, servicePhase: null, serviceId: reqId,
  }]);
  ui.ctx.stepSwarm(s, 0.25);

  // Handshake complete: service record deleted, mode transitions back to ok
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id], undefined);
  assert.strictEqual(d.mode, 'ok', 'drone must be back in ok mode');
  assert.ok(d.batteryPct >= 99, 'battery must be fresh after swap');
  if (s.stats) assert.strictEqual(s.stats.swaps, 1, 'one swap must be recorded');
  assert.strictEqual(d.swapAt, null);
});
