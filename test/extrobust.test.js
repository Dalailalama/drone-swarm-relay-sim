// Soak-audit findings R10/R12 (issue #22) — external-vehicle mode.
//  R10: externalPullPositions revived ANY dead drone once its telemetry
//       came back after a >3 s gap — an operator kill or a battery death
//       was undone by a telemetry hiccup. Only the link-loss ladder's own
//       "down" is recoverable.
//  R12: bridge messages were used without shape checks: a JSON `null`, a
//       non-array `vehicles`, or a null entry threw inside onmessage (the
//       whole batch lost), and a single glitched fix teleported a vehicle
//       1000 km with a telemetry-derived speed of ~2e7 m/s.
const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { loadUI } = require('./helpers/dom.js');

function connect() {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  ui.el('wsUrl').value = 'ws://test:1';
  ui.fire('extConnectBtn', 'click');
  const ws = ui.ctx.__sockets[ui.ctx.__sockets.length - 1];
  ws.onopen();
  const ids = s.drones.map(d => d.id);
  ws.onmessage({ data: JSON.stringify({ type: 'ready', ids, vehicles: ids.map(id => ({ id, ready: true, state: 'ready' })) }) });
  let seq = 1;
  const fix = (id, x, y) => ({ id, x, y, alt: 50, connected: true, armed: true, ready: true, state: 'ready', positionSeq: seq, positionAge: 0.05, heartbeatAge: 0.05 });
  const telemetry = (skip, place) => {
    seq++;
    const vehicles = s.drones.filter(d => d.id !== skip).map((d, i) => place ? place(d, i) : fix(d.id, 60 * Math.cos(i) + 5, 60 * Math.sin(i)));
    ws.onmessage({ data: JSON.stringify({ type: 'telemetry', vehicles }) });
  };
  return { ui, s, ws, telemetry, fix, nextSeq: () => ++seq };
}

test('R10: a drone killed by the operator stays dead through a telemetry gap', () => {
  const { ui, s, telemetry } = connect();
  for (let i = 0; i < 10; i++) { telemetry(); ui.ctx.__raf.pump(100); }
  const victim = s.drones[0];
  ui.ctx.killDrone(s, victim);
  for (let i = 0; i < 45; i++) { telemetry(victim.id); ui.ctx.__raf.pump(100); } // 4.5 s: stale
  for (let i = 0; i < 5; i++) { telemetry(); ui.ctx.__raf.pump(100); }            // back
  assert.strictEqual(victim.mode, 'dead', 'a telemetry gap resurrected a killed drone');
});

test('R10: a battery-dead drone is not revived (and not killed twice)', () => {
  const { ui, s, telemetry } = connect();
  for (let i = 0; i < 10; i++) { telemetry(); ui.ctx.__raf.pump(100); }
  const d = s.drones[1];
  d.energyWh = 0; d.mode = 'dead'; d.endpointDeadAt = s.time;
  for (let i = 0; i < 45; i++) { telemetry(d.id); ui.ctx.__raf.pump(100); }
  for (let i = 0; i < 5; i++) { telemetry(); ui.ctx.__raf.pump(100); }
  assert.strictEqual(d.mode, 'dead');
  assert.strictEqual(s.events.filter(e => e.msg.startsWith(d.id + ' battery exhausted')).length, 0,
    'a revive-then-die cycle logged a second "battery exhausted"');
});

test('R10: the link-loss ladder still recovers the drones IT took down', () => {
  const { ui, s, telemetry } = connect();
  for (let i = 0; i < 10; i++) { telemetry(); ui.ctx.__raf.pump(100); }
  const d = s.drones[2];
  for (let i = 0; i < 150; i++) { telemetry(d.id); ui.ctx.__raf.pump(100); } // 15 s silent
  assert.strictEqual(d.mode, 'dead', 'a sustained telemetry loss marks the vehicle down');
  for (let i = 0; i < 5; i++) { telemetry(); ui.ctx.__raf.pump(100); }
  assert.notStrictEqual(d.mode, 'dead', 'the vehicle came back: link-loss death is recoverable');
});

test('R12: malformed bridge messages never throw and never drop valid entries', () => {
  const { ui, s, ws, fix, nextSeq } = connect();
  for (const bad of ['null', '42', '"telemetry"', JSON.stringify({ type: 'telemetry', vehicles: { id: 'DR-1' } }),
    JSON.stringify({ type: 'ready', ids: 'x', vehicles: [null, 7] }), JSON.stringify({ type: 'telemetry', vehicles: [7, 'x', null] })]) {
    assert.doesNotThrow(() => ws.onmessage({ data: bad }), bad);
  }
  nextSeq();
  const good = fix('DR-2', 33, -4);
  good.positionSeq = nextSeq();
  assert.doesNotThrow(() => ws.onmessage({ data: JSON.stringify({ type: 'telemetry', vehicles: [null, { id: '__proto__', x: 1, y: 1, alt: 1 }, good] }) }));
  assert.strictEqual(ui.ctx.ExternalMode.telem['DR-2'] && ui.ctx.ExternalMode.telem['DR-2'].x, 33,
    'a null entry must not cost the valid vehicle its sample');
  assert.strictEqual(Object.getPrototypeOf(ui.ctx.ExternalMode.telem), vm.runInContext('Object.prototype', ui.ctx), 'telemetry ids must not rewrite prototypes');
  ui.ctx.externalPullPositions(s);
  assert.strictEqual(s.drones.find(d => d.id === 'DR-2').x - ui.ctx.ExternalMode.origin.x, 33);
});

test('R12: a one-sample position spike is rejected; a confirmed relocation is adopted', () => {
  const { ui, s, telemetry, fix } = connect();
  const d = s.drones[1];
  const place = x => (v, i) => v.id === d.id ? fix(v.id, x, 0) : fix(v.id, 60 * Math.cos(i), 60 * Math.sin(i));
  for (let i = 0; i < 5; i++) { telemetry(null, place(10 + i)); ui.ctx.__raf.pump(100); }
  const ox = ui.ctx.ExternalMode.origin.x;
  telemetry(null, place(1e6)); ui.ctx.__raf.pump(50);             // glitch
  assert.ok(Math.abs(d.x - ox) < 100, 'a 1000 km one-sample spike was adopted: x=' + (d.x - ox));
  assert.ok(Math.hypot(d.vx, d.vy) < 100, 'telemetry velocity must stay physical, got ' + Math.hypot(d.vx, d.vy));
  telemetry(null, place(16)); ui.ctx.__raf.pump(100);             // back to the real track
  assert.ok(Math.abs(d.x - ox - 16) < 1e-9, 'the next consistent fix applies');
  telemetry(null, place(5000)); ui.ctx.__raf.pump(100);           // genuine relocation...
  telemetry(null, place(5003)); ui.ctx.__raf.pump(100);           // ...confirmed by the next fix
  assert.ok(Math.abs(d.x - ox - 5003) < 1e-9, 'a relocation confirmed by consecutive fixes must be adopted');
  assert.ok(Math.hypot(d.vx, d.vy) < 100, 'no velocity is derived across the jump');
});
