// Audit (protocol-spec-not-implementable): docs/PROTOCOL.md is the contract
// a third-party server is built from, but its telemetry example lacked the
// landedSeq/landedAge fields grounded() requires, so a server that followed
// it to the letter could never get a battery swap authorized. Feed frames
// shaped EXACTLY like the documented example (same envelope and vehicle keys,
// nothing else) through external.js and require the swap handshake to work.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadUI } = require('./helpers/dom.js');

function docExample(type) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'docs', 'PROTOCOL.md'), 'utf8');
  for (const m of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    const obj = JSON.parse(m[1]);
    if (obj.type === type) return obj;
  }
  throw new Error('no ' + type + ' example in docs/PROTOCOL.md');
}

// A frame with only the documented keys: values from `over` where the doc
// has that key, the doc's own example value otherwise.
function docFrame(t, over) {
  const env = docExample('telemetry'), ex = env.vehicles[0], v = {};
  for (const k of Object.keys(ex)) v[k] = k in over ? over[k] : ex[k];
  const frame = {};
  for (const k of Object.keys(env)) frame[k] = k === 'vehicles' ? [v] : k === 'type' ? 'telemetry' : t;
  return JSON.stringify(frame);
}

test('PROTOCOL.md telemetry example is enough to land and get a swap authorized', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  ui.ctx.externalConnect(() => s, 'ws://test:1', s.drones.length, 60);
  const ws = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  ws.onopen();
  const ids = s.drones.map(d => d.id);
  ws.onmessage({ data: JSON.stringify({ type: 'ready', ids, vehicles: ids.map(id => ({ id, ready: true, state: 'ready' })) }) });
  const d = s.drones[0];
  const origin = ui.ctx.ExternalMode.origin;
  const at = { id: d.id, x: 2, y: 0, connected: true, heartbeatAge: 0, positionAge: 0, origin };
  ws.onmessage({ data: docFrame(1, { ...at, alt: 50, ready: true, state: 'ready', armed: true, positionSeq: 1,
    landed: false, landedSeq: 0, landedAge: null }) });
  d.mode = 'rtb';
  s.time += 1;
  ui.ctx.externalPushGoals(s);
  for (let i = 0; i < 8; i++) ui.ctx.stepSwarm(s, 0.25);
  const land = ws.sent.map(m => JSON.parse(m)).find(m => m.type === 'service' && m.action === 'land');
  assert.ok(land, 'a ready vehicle reported per PROTOCOL.md is sent the land service');
  ws.onmessage({ data: docFrame(2, { ...at, alt: 0.5, ready: false, state: 'landed', armed: false, positionSeq: 2,
    landed: true, landedSeq: 1, landedAge: 0.1, serviceId: land.requestId, servicePhase: 'landing' }) });
  ui.ctx.stepSwarm(s, 0.25);
  const authorize = ws.sent.map(m => JSON.parse(m)).filter(m => m.type === 'service' && m.action === 'authorize');
  assert.ok(authorize.length >= 1,
    'touchdown reported with exactly the PROTOCOL.md telemetry keys never authorized the swap');
});
