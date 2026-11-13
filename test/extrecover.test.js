// External-mode service recovery (review of the SITL handshake on HEAD).
//  land-fail-then-grounded: a landing the bridge timed out (servicePhase
//      'failed') that still ended on the pad came back as 'landed', but the
//      browser kept its record 'failed': no authorize was ever sent, and the
//      land retry wants the vehicle armed, so the drone sat on the pad.
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
