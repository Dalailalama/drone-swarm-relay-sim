// SITL fleet lifecycle across inits (audit cluster P6-sitl).
//  reinit-rearms-parked-vehicle: an init (reset, selector change, reload)
//      rebuilt every bridge vehicle and armed one parked mid battery swap.
//      The bridge now keeps it parked; the rebuilt swarm, whose service
//      records were wiped, must pick the bridge's service up and finish it.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

function connect(ui, ids) {
  const s = ui.ctx.sim.swarm;
  ui.ctx.externalConnect(() => ui.ctx.sim.swarm, 'ws://test:1', s.drones.length, 60);
  const ws = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  ws.onopen();
  ids = ids || s.drones.map(d => d.id);
  ws.onmessage({ data: JSON.stringify({ type: 'ready', ids, vehicles: ids.map(id => ({ id, ready: true, state: 'ready' })) }) });
  return ws;
}

const services = (ws, action) => ws.sent.map(m => JSON.parse(m))
  .filter(m => m.type === 'service' && (!action || m.action === action));

test('reinit-rearms-parked-vehicle: a vehicle the bridge kept parked mid-swap through a re-init finishes the swap and relaunches', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connect(ui);
  const d = s.drones[0];
  let seq = 0;
  const frame = (over) => ws.onmessage({ data: JSON.stringify({ type: 'telemetry', t: s.time, vehicles: [{
    id: d.id, x: 0, y: 0, alt: 0, connected: true, armed: false, landed: true, landedAge: 0, heartbeatAge: 0,
    positionAge: 0, ready: false, serviceId: '7', ...over, positionSeq: ++seq, landedSeq: seq }] }) });
  const ack = (action) => ws.onmessage({ data: JSON.stringify({ type: 'service_ack', id: d.id, requestId: '7', action, accepted: true }) });

  assert.strictEqual(ui.ctx.ExternalMode.services[d.id], undefined, 'the rebuilt swarm starts with no service record');
  frame({ state: 'swapping', servicePhase: 'swapping' });
  ui.ctx.stepSwarm(s, 0.25);
  const svc = ui.ctx.ExternalMode.services[d.id];
  assert.ok(svc && svc.id === '7' && svc.phase === 'swapping', 'the swap the bridge is running was not picked up');
  assert.strictEqual(d.mode, 'landed');

  ui.ctx.__clock.ms += (ui.ctx.BATTERY.swapSec + 5) * 1000;
  s.time += ui.ctx.BATTERY.swapSec + 5;
  frame({ state: 'swapping', servicePhase: 'swapping' });
  ui.ctx.stepSwarm(s, 0.25);
  const complete = services(ws, 'complete');
  assert.strictEqual(complete.length, 1, 'swap completion not requested');
  assert.strictEqual(complete[0].requestId, '7', 'the handshake continues under the bridge\'s request id');
  ack('complete');
  frame({ state: 'swapped', servicePhase: 'swapped' });
  ui.ctx.stepSwarm(s, 0.25);
  assert.strictEqual(services(ws, 'relaunch').length, 1, 'relaunch not requested');
  ack('relaunch');
  frame({ alt: 60, armed: true, landed: false, ready: true, state: 'ready', servicePhase: null });
  ui.ctx.stepSwarm(s, 0.25);
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id], undefined);
  assert.strictEqual(d.mode, 'ok', 'the relaunched vehicle is back in the fleet');
  assert.ok(ui.ctx.ExternalMode.serviceSeq >= 7, 'later request ids must not reuse the adopted one');
});
