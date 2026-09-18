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
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function connectBridge(ui, count) {
  ui.el('wsUrl').value = 'ws://test:1';
  ui.fire('extConnectBtn', 'click');
  const ws = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  ws.onopen();
  const ids = [];
  for (let i = 1; i <= (count || +ui.el('countRange').value); i++) ids.push('DR-' + i);
  ws.onmessage({ data: bridgeReady(ids) });
  return ws;
}

function sendTelemetry(ws, t, vehicles) {
  ws.onmessage({ data: JSON.stringify({ type: 'telemetry', t, vehicles }) });
}

function bridgeReady(ids, entries) {
  const vehicles = ids.map((id, i) => {
    const e = entries && entries[i];
    return { id, ready: e ? e.ready : true, state: e ? e.state : 'ready' };
  });
  return JSON.stringify({ type: 'ready', ids, vehicles });
}

test('F01: a failed vehicle is not declared fleet-ready and gets no goals', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  ui.ctx.externalConnect(() => s, 'ws://test:1', s.drones.length, 60);
  const ws = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  ws.onopen();
  ws.onmessage({ data: bridgeReady(['DR-1', 'DR-2'], [{ ready: true, state: 'ready' }, { ready: false, state: 'failed:arm' }]) });
  assert.strictEqual(ui.ctx.ExternalMode.ready, true, 'the healthy vehicle still flies');
  assert.strictEqual(ui.ctx.ExternalMode.vehicleStates['DR-2'].ready, false,
    'per-vehicle failure must not be swallowed by a fleet-wide flag');
  assert.strictEqual(ui.ctx.ExternalMode.vehicleStates['DR-2'].state, 'failed:arm');
  sendTelemetry(ws, 1, [
    { id: 'DR-1', x: 100, y: 0, alt: 50, connected: true, armed: true, ready: true, state: 'ready', positionSeq: 3, positionAge: 0.1 },
    { id: 'DR-2', x: 120, y: 0, alt: 0, connected: true, armed: true, ready: false, state: 'failed:arm', positionSeq: 7, positionAge: 0.1 },
  ]);
  for (const d of s.drones) { d.goalX = d.x + 50; d.goalY = d.y; }
  s.time += 1;
  ui.ctx.externalPushGoals(s);
  const goalMsgs = ws.sent.map(m => JSON.parse(m)).filter(m => m.type === 'goals');
  const last = goalMsgs[goalMsgs.length - 1];
  const idsShipped = last.goals.map(g => g.id);
  assert.ok(!idsShipped.includes('DR-2'),
    'mission goals were shipped to a vehicle whose arm was never confirmed');
  sendTelemetry(ws, 2, [
    { id: 'DR-2', x: 120, y: 0, alt: 50, connected: true, armed: true, ready: true, state: 'ready', positionSeq: 8, positionAge: 0.1 },
  ]);
  assert.strictEqual(ui.ctx.ExternalMode.vehicleStates['DR-2'].ready, true,
    'telemetry readiness must refresh the per-vehicle state for late recovery');
});

test('F03: a fresh heartbeat cannot conceal a stalled position stream', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  ui.ctx.externalConnect(() => s, 'ws://test:1', s.drones.length, 60);
  const ws = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  ws.onopen();
  ws.onmessage({ data: bridgeReady(s.drones.map(d => d.id)) });
  const d = s.drones[0];
  sendTelemetry(ws, 1, [{ id: d.id, x: 50, y: 0, alt: 30, connected: true, armed: true, ready: true, state: 'ready', positionSeq: 5, positionAge: 0.1 }]);
  ui.ctx.externalPullPositions(s);
  assert.strictEqual(d.x, 50);
  ui.ctx.__clock.ms += 30000;
  sendTelemetry(ws, 100, [{ id: d.id, x: 50, y: 0, alt: 30, connected: true, armed: true, ready: true, state: 'ready', positionSeq: 5, positionAge: 29.9 }]);
  d.x = 111;
  s.time = 1000;
  ui.ctx.externalPullPositions(s);
  assert.strictEqual(d.vx, 0, 'a vehicle with no new position samples must read as frozen');
  assert.strictEqual(d.x, 111, 'stale telemetry must not overwrite the frozen position');
  assert.strictEqual(d.extLostSince, 1000, 'stale position must enter link-loss hold');
  sendTelemetry(ws, 101, [{ id: d.id, x: 60, y: 0, alt: 30, connected: true, armed: true, ready: true, state: 'ready', positionSeq: 6, positionAge: 0.0 }]);
  s.time += 0.05;
  ui.ctx.externalPullPositions(s);
  assert.strictEqual(d.x, 60, 'a genuinely fresh position sample applies again');
});

test('F03: never-received position data is not a measurement', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  ui.ctx.externalConnect(() => s, 'ws://test:1', s.drones.length, 60);
  const ws = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  ws.onopen();
  ws.onmessage({ data: bridgeReady(s.drones.map(d => d.id)) });
  const d = s.drones[0];
  d.x = 123; d.y = 45;
  sendTelemetry(ws, 1, [{ id: d.id, x: 0, y: 0, alt: 0, connected: true, armed: true, ready: true, state: 'ready', positionSeq: 0, positionAge: null }]);
  ui.ctx.externalPullPositions(s);
  assert.strictEqual(d.x, 123, 'zero coordinates from an uninitialized vehicle must not be adopted as truth');
  assert.strictEqual(d.y, 45);
});

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
  wsB.onmessage({ data: bridgeReady(['DR-1', 'DR-2', 'DR-3', 'DR-4']) });
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
  sendTelemetry(ws, 1, [{ id: d.id, x: 250, y: 0, alt: 50, connected: true, armed: true, ready: true, state: 'ready', positionSeq: 1, positionAge: 0 }]);
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

test('F05: browser JSON and native MAVLink round trip use one immutable world mapping', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  s.base.x = 1000; s.base.y = 500;
  vm.runInContext('terrainGroundAt = (_terrain, x, y) => x === 1000 && y === 500 ? 250 : 300', ui.ctx);
  const ws = connectBridge(ui);
  const init = JSON.parse(ws.sent[0]);
  assert.deepStrictEqual(init.origin, { frame: 'common-local-origin', x: 1000, y: 500, groundM: 250 });
  const exchange = goals => {
    const result = spawnSync('python', ['-B', '-c', `
import asyncio, json, sys
sys.path.insert(0, 'sitl')
import test_bridge as h
b = h.bridge
async def run():
    data = json.load(sys.stdin)
    harness = h.Harness()
    ws = harness.client('browser')
    async def start(v):
        v.conn = h.conn_for(v.port)
        v.guided_mode_id = h.GUIDED_MODE_ID
        v.conn.push(h.hb_msg(armed=True, custom_mode=h.GUIDED_MODE_ID))
        v.conn.push(h.pos_msg(0, 0, -120))
        b._drain_messages(v)
        v.ready = True
        v.init_state = b.INIT_READY
        v.first_pass_done.set()
    with h.patch.object(b, 'vehicle_task', start):
        await b.handle_message(ws, json.dumps(data['init']), None, 14550)
    v = b.STATE.vehicles['DR-1']
    samples = [v.to_telemetry()]
    for north, east, down in [(-4, 10, -120), (-4, 10, -50)]:
        v.conn.push(h.pos_msg(north, east, down))
        b._drain_messages(v)
        samples.append(v.to_telemetry())
    await b.handle_message(ws, json.dumps(data['goals']), None, 14550)
    print(json.dumps({'samples': samples, 'setpoints': v.conn.details('setpoint')}))
    await harness.close()
asyncio.run(run())
`], { cwd: path.join(__dirname, '..'), input: JSON.stringify({ init: { ...init, count: 1 }, goals }), encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const response = exchange({ type: 'goals', goals: [] });
  const d = s.drones[0];
  sendTelemetry(ws, 1, [response.samples[0]]);
  ui.ctx.externalPullPositions(s);
  assert.deepStrictEqual([d.x, d.y, d.altM], [1000, 500, 120]);
  s.base.x = 2000; s.base.y = 900;
  sendTelemetry(ws, 2, [response.samples[1]]);
  ui.ctx.externalPullPositions(s);
  assert.deepStrictEqual([d.x, d.y, d.altM], [1010, 504, 70]);
  d.goalX = 1010; d.goalY = 504; s.altitudeM = 70; s.time = 1;
  ui.ctx.externalPushGoals(s);
  const goals = ws.sent.map(JSON.parse).filter(m => m.type === 'goals').at(-1);
  assert.deepStrictEqual(goals.goals, [{ id: d.id, x: 10, y: 4, alt: 120 }]);
  assert.deepStrictEqual(exchange(goals).setpoints, [{ north: -4, east: 10, down: -120, frame: 1, mask: 4088 }]);
  sendTelemetry(ws, 3, [response.samples[2]]);
  ui.ctx.externalPullPositions(s);
  assert.deepStrictEqual([d.x, d.y, d.altM], [1010, 504, 0]);
  assert.strictEqual(ui.ctx.ExternalMode.origin.groundM, 250);
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
  sendTelemetry(ws, 2, [{ id: d.id, x: pos.x, y: pos.y, alt: 120, connected: true, armed: true, ready: true, state: 'ready', positionSeq: 1, positionAge: 0 }]);
  ui.ctx.externalPullPositions(s);
  const expected = 120 + groundAt(s.base.x, s.base.y) - groundAt(pos.x, pos.y);
  assert.ok(Math.abs(d.altM - expected) < 1e-6,
    'altM must be AGL at the vehicle (origin-relative ' + 120 + ' -> ' + expected.toFixed(1) +
    '), got ' + d.altM);
  assert.ok(Math.abs(groundAt(s.base.x, s.base.y) - groundAt(pos.x, pos.y)) > 1,
    'probe sanity: terrain must actually differ between base and vehicle');
});
