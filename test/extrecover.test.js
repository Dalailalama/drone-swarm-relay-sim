// External-mode service recovery (review of the SITL handshake on HEAD).
//  land-fail-then-grounded: a landing the bridge timed out (servicePhase
//      'failed') that still ended on the pad came back as 'landed', but the
//      browser kept its record 'failed': no authorize was ever sent, and the
//      land retry wants the vehicle armed, so the drone sat on the pad.
//  relaunch-refused-redone: after a relaunch the autopilot refused the
//      bridge has the vehicle back in 'landed' and takes the swap handshake
//      again under its request id, but the browser stayed in 'relaunch' and
//      the drone stayed landed in the sim until a re-init or reload.
//  stale-home-land: external mode decided touchdown against the TRUE base,
//      stepDrone on the drone's belief against the home it last learned
//      (ONB-01): a drone flying home to a stale fix never got a land
//      command and hovered there until its pack was empty.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

function connect(ui) {
  const s = ui.ctx.sim.swarm;
  ui.ctx.externalConnect(() => ui.ctx.sim.swarm, 'ws://test:1', s.drones.length, 60);
  const ws = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  ws.onopen();
  const ids = s.drones.map(d => d.id);
  ws.onmessage({ data: JSON.stringify({ type: 'ready', ids, vehicles: ids.map(id => ({ id, ready: true, state: 'ready' })) }) });
  return ws;
}

const services = (ws, action) => ws.sent.map(m => JSON.parse(m))
  .filter(m => m.type === 'service' && (!action || m.action === action));

// One vehicle's telemetry, fresh on every frame; `over` sets the state.
function telemetry(ui, ws, d) {
  let seq = 0;
  return (over) => ws.onmessage({ data: JSON.stringify({ type: 'telemetry', t: ui.ctx.sim.swarm.time, vehicles: [{
    id: d.id, x: 2, y: 0, alt: 20, connected: true, armed: true, heartbeatAge: 0, positionAge: 0,
    ready: true, state: 'ready', ...over, positionSeq: ++seq, landedSeq: seq }] }) });
}

const ack = (ws, d, requestId, action, over) => ws.onmessage({ data: JSON.stringify({
  type: 'service_ack', id: d.id, requestId, action, accepted: true, ...over }) });

// Hover over the pad in RTB until the land request goes out, then have the
// bridge take it and give up on it (no descent progress).
function failLanding(ui, ws, d, frame) {
  const s = ui.ctx.sim.swarm;
  frame({});
  d.mode = 'rtb';
  s.time += 1;
  for (let i = 0; i < 4; i++) ui.ctx.stepSwarm(s, 0.25);
  const land = services(ws, 'land')[0];
  assert.ok(land, 'the drone over the pad asks to land');
  ack(ws, d, land.requestId, 'land');
  frame({ ready: false, state: 'landing', servicePhase: 'landing', serviceId: land.requestId });
  frame({ ready: false, state: 'failed:land', servicePhase: 'failed', serviceId: land.requestId });
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id].phase, 'failed');
  return land;
}

const onPad = (serviceId) => ({ alt: 0, armed: false, landed: true, landedAge: 0, ready: false,
  state: 'landed', servicePhase: 'landed', serviceId });

test('land-fail-then-grounded: a vehicle that touches down after the bridge timed its landing out goes on to the swap', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connect(ui);
  const d = s.drones[0];
  const frame = telemetry(ui, ws, d);
  const land = failLanding(ui, ws, d, frame);

  // The slow descent sets down and disarms before the retry is due: the
  // bridge recovers the vehicle to 'landed' under the landing's id.
  for (let i = 0; i < 20 && !services(ws, 'authorize').length; i++) {
    ui.ctx.__clock.ms += 250; frame(onPad(land.requestId)); ui.ctx.stepSwarm(s, 0.25);
  }
  const auth = services(ws, 'authorize');
  assert.strictEqual(auth.length, 1, 'a grounded vehicle after a failed landing is never authorized for the swap');
  assert.strictEqual(auth[0].requestId, land.requestId, 'the handshake continues under the landing\'s request id');
  assert.strictEqual(services(ws, 'land').length, 1, 'a vehicle on the ground is not told to land again');

  ack(ws, d, land.requestId, 'authorize');
  frame({ ...onPad(land.requestId), state: 'swapping', servicePhase: 'swapping' });
  ui.ctx.stepSwarm(s, 0.25);
  assert.strictEqual(d.mode, 'landed');
  assert.ok(d.swapAt > s.time, 'the battery swap is under way');
  assert.ok(!ui.ctx.getExternalDiagnostics().find(v => v.id === d.id).failureReason, 'the old failure no longer stands');
});

test('land-fail-then-grounded: a land retry the bridge refused because the vehicle was already down gives way to the swap', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connect(ui);
  const d = s.drones[0];
  const frame = telemetry(ui, ws, d);
  const land = failLanding(ui, ws, d, frame);

  ui.ctx.__clock.ms += 3500;
  for (let i = 0; i < 4 && services(ws, 'land').length < 2; i++) {
    frame({ ready: false, state: 'failed:land', servicePhase: 'failed', serviceId: land.requestId });
    ui.ctx.stepSwarm(s, 0.25);
  }
  const retry = services(ws, 'land')[1];
  assert.ok(retry && retry.requestId !== land.requestId, 'the failed landing is retried under a new request id');
  // It touched down as the retry went out: the bridge refuses it and has
  // the vehicle back in 'landed' under the first landing's id.
  ack(ws, d, retry.requestId, 'land', { accepted: false, retryable: true, code: 'VEHICLE_NOT_READY' });
  for (let i = 0; i < 20 && !services(ws, 'authorize').length; i++) {
    ui.ctx.__clock.ms += 250; frame(onPad(land.requestId)); ui.ctx.stepSwarm(s, 0.25);
  }
  const auth = services(ws, 'authorize');
  assert.strictEqual(auth.length, 1, 'the vehicle on the pad is never authorized for the swap');
  assert.strictEqual(auth[0].requestId, land.requestId, 'the swap runs under the request id the bridge holds');
});

// A vehicle the bridge kept parked in 'swapped' is adopted and relaunched;
// returns the request id the handshake runs under.
function parkAndRelaunch(ui, ws, d, frame) {
  const s = ui.ctx.sim.swarm;
  frame({ ...onPad('9'), state: 'swapped', servicePhase: 'swapped' });
  ui.ctx.stepSwarm(s, 0.25);
  assert.strictEqual(d.mode, 'landed');
  const sent = until(ui, ws, 'relaunch', (ui.ctx.BATTERY.swapSec + 5) * 4,
    () => frame({ ...onPad('9'), state: 'swapped', servicePhase: 'swapped' }));
  assert.strictEqual(sent.length, 1, 'relaunch not requested');
  ack(ws, d, '9', 'relaunch');
  return '9';
}

// Steps 250 ms at a time, feeding `feed`, until `action` goes out (or n steps).
function until(ui, ws, action, n, feed) {
  const s = ui.ctx.sim.swarm;
  const k = services(ws, action).length;
  for (let i = 0; i < n && services(ws, action).length === k; i++) {
    ui.ctx.__clock.ms += 250; feed(); ui.ctx.stepSwarm(s, 0.25);
  }
  return services(ws, action).slice(k);
}

// The autopilot refuses the relaunch (arm denied): the bridge parks it and,
// grounded, has it back in 'landed'. Returns the authorize the redo sends.
function refuseRelaunch(ui, ws, d, frame, id) {
  frame({ ...onPad(id), state: 'failed:arm', servicePhase: 'failed' });
  return until(ui, ws, 'authorize', 40, () => frame(onPad(id)));
}

test('relaunch-refused-redone: a relaunch the autopilot refused is redone through the swap handshake from the pad', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connect(ui);
  const d = s.drones[0];
  const frame = telemetry(ui, ws, d);
  const id = parkAndRelaunch(ui, ws, d, frame);
  const swaps = s.stats.swaps || 0;

  frame({ ...onPad(id), state: 'failed:arm', servicePhase: 'failed' });
  assert.ok(s.events.some(e => e.msg.startsWith('External: ' + d.id + ' relaunch failed on the bridge (failed:arm)')),
    'the refused relaunch is not surfaced');
  frame(onPad(id));
  ui.ctx.stepSwarm(s, 0.25);
  assert.strictEqual(services(ws, 'authorize').length, 0, 'the redo is throttled, not fired on the first landed frame');
  const auth = until(ui, ws, 'authorize', 40, () => frame(onPad(id)));
  assert.strictEqual(auth.length, 1, 'the swap handshake is never redone, so the drone stays on the pad');
  assert.strictEqual(auth[0].requestId, id, 'the redo runs under the request id the bridge holds');

  ack(ws, d, id, 'authorize');
  const complete = until(ui, ws, 'complete', 8, () => frame({ ...onPad(id), state: 'swapping', servicePhase: 'swapping' }));
  assert.strictEqual(complete.length, 1, 'swap completion not requested again');
  ack(ws, d, id, 'complete');
  const relaunch = until(ui, ws, 'relaunch', 8, () => frame({ ...onPad(id), state: 'swapped', servicePhase: 'swapped' }));
  assert.strictEqual(relaunch.length, 1, 'relaunch not requested again');
  assert.strictEqual(relaunch[0].requestId, id);
  ack(ws, d, id, 'relaunch');
  frame({ alt: 60, armed: true, landed: false, ready: true, state: 'ready', servicePhase: null, serviceId: id });
  ui.ctx.stepSwarm(s, 0.25);
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id], undefined);
  assert.strictEqual(d.mode, 'ok', 'the relaunched vehicle is back in the fleet');
  assert.strictEqual(s.stats.swaps, swaps + 1, 'one battery swap, counted once');
});

test('relaunch-refused-redone: relaunches are capped, and the capped failure is reported with the vehicle left on the pad', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connect(ui);
  const d = s.drones[0];
  const frame = telemetry(ui, ws, d);
  const id = parkAndRelaunch(ui, ws, d, frame);
  for (let attempt = 1; attempt < 3; attempt++) {
    assert.strictEqual(refuseRelaunch(ui, ws, d, frame, id).length, 1, 'redo ' + attempt + ' never starts');
    ack(ws, d, id, 'authorize');
    until(ui, ws, 'complete', 8, () => frame({ ...onPad(id), state: 'swapping', servicePhase: 'swapping' }));
    ack(ws, d, id, 'complete');
    assert.strictEqual(until(ui, ws, 'relaunch', 8, () => frame({ ...onPad(id), state: 'swapped', servicePhase: 'swapped' })).length, 1);
    ack(ws, d, id, 'relaunch');
  }
  assert.strictEqual(services(ws, 'relaunch').length, 3);
  assert.strictEqual(refuseRelaunch(ui, ws, d, frame, id).length, 0, 'a third refusal is not redone');
  assert.ok(s.events.some(e => e.msg === 'External: ' + d.id + ' relaunch failed on the bridge (failed:arm) after 3 attempts — vehicle left on the pad'),
    'the capped failure is not reported');
  const diag = ui.ctx.getExternalDiagnostics().find(v => v.id === d.id);
  assert.ok(diag.servicePhase === 'failed' && diag.failureReason === 'failed:arm', JSON.stringify(diag));
  assert.strictEqual(d.mode, 'landed', 'the vehicle on the pad is not flying in the sim');
});

test('stale-home-land: an external drone at the stale home it last learned is told to land there, and gets no phantom swap', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connect(ui);
  const d = s.drones[0];
  const frame = telemetry(ui, ws, d);
  const home = { x: d.baseKnown.x, y: d.baseKnown.y };
  // The operator relocates 3 km while C2 is silent: the drone, flying home
  // in rtl, still knows the old base.
  s.c2.nextCmd = Infinity;
  s.base.x += 3000;
  d.mode = 'rtl';
  s.time += 1;
  for (let i = 0; i < 4; i++) { ui.ctx.__clock.ms += 250; frame({ alt: 50 }); ui.ctx.stepSwarm(s, 0.25); }
  assert.deepStrictEqual({ x: d.baseKnown.x, y: d.baseKnown.y }, home, 'precondition: the home it knows is stale');
  const land = services(ws, 'land')[0];
  assert.ok(land, 'a drone hovering over the home it knows is never told to land');
  const goals = ws.sent.map(m => JSON.parse(m)).filter(m => m.type === 'goals').at(-1);
  assert.ok(!goals.goals.some(g => g.id === d.id), 'no cruising goal competes with the landing');

  ack(ws, d, land.requestId, 'land');
  for (let i = 0; i < 20; i++) { ui.ctx.__clock.ms += 250; frame(onPad(land.requestId)); ui.ctx.stepSwarm(s, 0.25); }
  assert.strictEqual(services(ws, 'authorize').length, 0, 'no ground crew at the stale home — no battery swap');
  assert.strictEqual(d.mode, 'landed', 'the vehicle on the ground is not flying in the sim');
  assert.strictEqual(d.swapAt, null);
  assert.ok(s.events.some(e => e.msg === d.id + ' landed at its last-known base — no ground crew there'));
});
