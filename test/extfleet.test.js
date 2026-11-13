// SITL fleet lifecycle across inits (audit cluster P6-sitl).
//  reinit-rearms-parked-vehicle: an init (reset, selector change, reload)
//      rebuilt every bridge vehicle and armed one parked mid battery swap.
//      The bridge now keeps it parked; the rebuilt swarm, whose service
//      records were wiped, must pick the bridge's service up and finish it.
//  cli-count-ghost-drones: `bridge.py --count 3` under a 10-drone swarm left
//      7 drones with no vehicle alive at the base, planned as relays, while
//      the status said every vehicle was ready.
//  land-not-resent-browser-stuck: a landing the bridge gave up on (state
//      failed:land) left the drone hovering over the pad with no goals and no
//      further service attempt, and nothing said so.
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

test('cli-count-ghost-drones: drones the bridge has no vehicle for go down, are never relays, and readiness reads 3/N', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const n = s.drones.length;
  assert.ok(n > 3, 'needs more drones than the bridge has vehicles');
  const real = ['DR-1', 'DR-2', 'DR-3'];
  const ws = connect(ui, real);
  for (let i = 1; i <= 120; i++) { // 12 s of telemetry for the three real vehicles only
    ws.onmessage({ data: JSON.stringify({ type: 'telemetry', t: i / 10, vehicles: real.map((id, k) => ({
      id, x: 30 * (k + 1), y: 0, alt: 60, connected: true, armed: true, ready: true, state: 'ready',
      positionSeq: i, positionAge: 0.05, heartbeatAge: 0.05 })) }) });
    ui.ctx.__raf.pump(100);
  }
  const ghosts = s.drones.filter(d => !real.includes(d.id));
  const up = ghosts.filter(d => d.mode !== 'dead').map(d => d.id);
  assert.strictEqual(up.length, 0, 'drones with no vehicle on the bridge still in the fleet: ' + up);
  assert.ok(s.events.some(e => e.msg === ghosts[0].id + ' has no vehicle on the bridge — marking down'));
  const relays = s.drones.filter(d => ui.ctx.alive(d) && d.order && d.order.role === 'relay').map(d => d.id);
  assert.ok(relays.every(id => real.includes(id)), 'relay roles held by drones with no vehicle: ' + relays);
  assert.ok(real.every(id => ui.ctx.alive(s.drones.find(d => d.id === id))), 'the real vehicles stay up');
  assert.ok(ui.ctx.ExternalMode.status.includes('(3/' + n + ' confirmed ready)'), ui.ctx.ExternalMode.status);
});

test('land-not-resent-browser-stuck: a landing the bridge reports failed is surfaced and retried under a new request id', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  const ws = connect(ui);
  const d = s.drones[0];
  let seq = 0;
  const frame = (over) => ws.onmessage({ data: JSON.stringify({ type: 'telemetry', t: s.time, vehicles: [{
    id: d.id, x: 2, y: 0, alt: 20, connected: true, armed: true, heartbeatAge: 0, positionAge: 0,
    ready: true, state: 'ready', ...over, positionSeq: ++seq }] }) });
  frame({});
  d.mode = 'rtb';
  s.time += 1;
  ui.ctx.externalPushGoals(s);
  for (let i = 0; i < 4; i++) ui.ctx.stepSwarm(s, 0.25);
  const land = services(ws, 'land')[0];
  assert.ok(land, 'the drone over the pad asks to land');
  ws.onmessage({ data: JSON.stringify({ type: 'service_ack', id: d.id, requestId: land.requestId, action: 'land', accepted: true }) });
  const failed = { ready: false, state: 'failed:land', servicePhase: 'failed', serviceId: land.requestId };
  frame({ ready: false, state: 'landing', servicePhase: 'landing', serviceId: land.requestId });
  frame(failed);
  const svc = ui.ctx.ExternalMode.services[d.id];
  assert.strictEqual(svc.phase, 'failed', 'the bridge-side failure is not reflected');
  assert.ok(s.events.some(e => e.msg === 'External: DR-1 landing failed on the bridge (failed:land) — retrying'),
    'the failure is not surfaced');

  ui.ctx.__clock.ms += 3500;
  for (let i = 0; i < 4; i++) { frame(failed); ui.ctx.stepSwarm(s, 0.25); }
  const lands = services(ws, 'land');
  assert.strictEqual(lands.length, 2, 'the failed landing is never tried again');
  assert.notStrictEqual(lands[1].requestId, land.requestId, 'a retry needs a fresh request id');
  assert.strictEqual(ui.ctx.ExternalMode.services[d.id].phase, 'landing');
});
