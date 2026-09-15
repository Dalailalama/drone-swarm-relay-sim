// External-mode lifecycle findings (review of ffb35e6):
//  #9  (B45) telemetry had no receipt-age timeout — a sample from t=1 stayed
//      "current" at t=1000 if the socket idled without traffic;
//  #10 (B46) a previous socket's delayed onclose clobbered the NEW
//      connection's state;
//  #24 (B49) one count-slider change sent TWO init messages (resetSwarm's
//      central sync plus the handler's own call) — and real inits arm and
//      launch physical vehicles;
//  #25 (B9)  the bridge reports origin-relative altitude (-NED.z per
//      MAVLink's local frame) but the RF model treated it as AGL at the
//      vehicle's position — the frames differ over terrain.
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { loadUI } = require('./helpers/dom.js');

function connectBridge(ui, count) {
  ui.el('wsUrl').value = 'ws://test:1';
  ui.fire('extConnectBtn', 'click');
  const ws = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  ws.onopen();
  const ids = [];
  for (let i = 1; i <= (count || +ui.el('countRange').value); i++) ids.push('DR-' + i);
  ws.onmessage({ data: JSON.stringify({ type: 'ready', ids }) });
  return ws;
}

function sendTelemetry(ws, t, vehicles) {
  ws.onmessage({ data: JSON.stringify({ type: 'telemetry', t, vehicles }) });
}

test('regression #10: a stale socket\'s late close cannot break the new connection', () => {
  const ui = loadUI();
  const s = () => ui.ctx.sim.swarm;
  ui.ctx.externalConnect(s, 'ws://test:1', 4, 60);
  const wsA = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  wsA.onopen();
  // Operator reconnects; then A's close event arrives LATE (network delay).
  ui.ctx.externalConnect(s, 'ws://test:2', 4, 60);
  const wsB = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  wsB.onopen();
  wsB.onmessage({ data: JSON.stringify({ type: 'ready', ids: ['DR-1', 'DR-2', 'DR-3', 'DR-4'] }) });
  assert.strictEqual(ui.ctx.ExternalMode.ready, true, 'B is flying');
  wsA.onclose({ type: 'close' }); // the ghost of connection A
  assert.strictEqual(ui.ctx.ExternalMode.connected, true,
    'a dead socket\'s close event disconnected the LIVE bridge');
  assert.strictEqual(ui.ctx.ExternalMode.ready, true,
    'a dead socket\'s close event un-readied the LIVE bridge');
  assert.strictEqual(ui.ctx.ExternalMode.ws, wsB, 'B remains the selected socket');
});

test('regression #9: telemetry goes stale by LOCAL receipt age, not bridge claims', () => {
  const ui = loadUI();
  const ws = connectBridge(ui);
  const s = ui.ctx.sim.swarm;
  const d = s.drones[0];
  sendTelemetry(ws, 1, [{ id: d.id, x: 250, y: 0, alt: 50, connected: true }]);
  ui.ctx.externalPullPositions(s);
  assert.strictEqual(d.x, 250, 'fresh telemetry applies');
  // The socket stays open but telemetry STOPS: 30 s of wall clock pass.
  ui.ctx.__clock.ms += 30000;
  d.x = 111; // sim-side drift attempt: stale data must not keep overwriting
  s.time = 1000;
  ui.ctx.externalPullPositions(s);
  assert.ok(d.x !== 250 || d.extLostSince != null,
    'a 30 s-old sample was still treated as an actively-reporting vehicle');
  assert.strictEqual(d.vx, 0, 'stale vehicle must read as frozen, not moving');
});

test('regression #24: one count change sends exactly one bridge init', () => {
  const ui = loadUI();
  const ws = connectBridge(ui);
  const before = ws.sent.filter(m => JSON.parse(m).type === 'init').length;
  ui.el('countRange').value = '7';
  ui.fire('countRange', 'change');
  const after = ws.sent.filter(m => JSON.parse(m).type === 'init').length;
  assert.strictEqual(after - before, 1,
    'a single slider change sent ' + (after - before) + ' init messages (arms real vehicles twice)');
});

test('regression #25: origin-relative bridge altitude converts to AGL over terrain', () => {
  const ui = loadUI();
  // Rolling terrain: ground height differs between the base and the vehicle.
  ui.el('terrainSel').value = 'rolling';
  ui.fire('terrainSel', 'change');
  const ws = connectBridge(ui);
  const s = ui.ctx.sim.swarm;
  const d = s.drones[0];
  const groundAt = (x, y) => vm.runInContext('terrainGroundAt', ui.ctx)(s.terrain, x, y);
  const pos = { x: 400, y: -150 };
  sendTelemetry(ws, 2, [{ id: d.id, x: pos.x, y: pos.y, alt: 120, connected: true }]);
  ui.ctx.externalPullPositions(s);
  const expected = 120 + groundAt(s.base.x, s.base.y) - groundAt(pos.x, pos.y);
  assert.ok(Math.abs(d.altM - expected) < 1e-6,
    'altM must be AGL at the vehicle (origin-relative ' + 120 + ' -> ' + expected.toFixed(1) +
    '), got ' + d.altM);
  assert.ok(Math.abs(groundAt(s.base.x, s.base.y) - groundAt(pos.x, pos.y)) > 1,
    'probe sanity: terrain must actually differ between base and vehicle');
});
