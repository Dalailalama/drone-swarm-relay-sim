// Audit C2-07: C2 benched a decliner only if it saw reject:'relay' in fresh
// telemetry while the drone was still on its relay roster. The drone cleared
// rejectedRole on its next accepted order, which is usually the mission
// order C2 sends as soon as it strikes the drone off for staleness, before
// slow telemetry ever carried the decline. C2 never benched it and re-elected
// the same drone, wasting a ~35 s round each time on LoRa.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function setup() {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 4, airframe: Q450, radio: SIK, envFactor: 1, targetX: 300, targetY: 0, seed: 3 });
  const d = s.drones[0];
  s.time = 1;
  const order = (role, extra) => Object.assign({ role, slot: role === 'relay' ? 0 : -1, k: role === 'relay' ? 1 : 0,
    upstream: 'C2', c2: { x: s.base.x, y: s.base.y, at: s.time }, target: { x: s.target.x, y: s.target.y } }, extra);
  const deliver = o => { d.inbox.push({ kind: 'cmd', src: 'C2', dst: d.id, payload: o }); ctx.droneComms(s, d); };
  const telemetry = () => {
    const sent = [];
    const real = ctx.sendPacket;
    ctx.sendPacket = (sim, kind, src, dst, payload, bytes) => {
      if (kind === 'tlm' && src === d.id) sent.push(payload);
      return real(sim, kind, src, dst, payload, bytes);
    };
    d.nextTlm = s.time;
    try { ctx.droneComms(s, d); } finally { ctx.sendPacket = real; }
    assert.strictEqual(sent.length, 1, 'one telemetry report');
    return sent[0];
  };
  return { ctx, s, d, order, deliver, telemetry };
}

test('C2-07: a decline reaches C2 and benches the drone even after it accepted its next order', () => {
  const { ctx, s, d, order, deliver, telemetry } = setup();
  deliver(order('relay', { slotPos: { x: 20000, y: 0 } })); // a slot it cannot close
  assert.strictEqual(d.order.role, 'mission', 'the drone must decline the slot');
  // C2 has struck it off for staleness and sends the mission order: accepted.
  deliver(order('mission'));
  const tlm = telemetry();
  s.c2.inbox.push({ src: d.id, payload: tlm });
  s.c2.nextCmd = 0;
  ctx.c2Step(s);
  assert.ok(s.c2.unfit[d.id] > s.time, 'C2 never benched ' + d.id + ' after its decline; telemetry ' + JSON.stringify(tlm.reject));
  assert.ok(!s.c2.relays.includes(d.id), 'a benched decliner must not be on the relay roster');
});

test('C2-07: one decline benches once; the drone is electable again when the bench expires (guard)', () => {
  const { ctx, s, d, order, deliver, telemetry } = setup();
  deliver(order('relay', { slotPos: { x: 20000, y: 0 } }));
  deliver(order('mission'));
  const tlm = telemetry();
  s.c2.inbox.push({ src: d.id, payload: tlm });
  s.c2.nextCmd = 0;
  ctx.c2Step(s);
  const until = s.c2.unfit[d.id];
  assert.ok(until > s.time);
  s.time = until + 1;
  s.c2.inbox.push({ src: d.id, payload: telemetry() }); // same decline, reported again
  s.c2.nextCmd = 0;
  ctx.c2Step(s);
  assert.ok(!(s.c2.unfit[d.id] > s.time), 'an old decline re-benched the drone');
});

// A decline is about the pack it was made on. One the drone turned for home
// before reporting (RTB stops telemetry) rode in its first report after the
// crew's swap, and C2 benched a full-battery drone for "low reserves".
test('a decline made on the old pack does not bench the drone once the crew has swapped it', () => {
  const { ctx, s, d, order, deliver, telemetry } = setup();
  deliver(order('relay', { slotPos: { x: 20000, y: 0 } })); // a slot it cannot close
  assert.strictEqual(d.rejectSeq, 1, 'setup: the drone must decline the slot');
  // Battery RTB before the next report carried it; landed at base for a swap.
  d.mode = 'landed'; d.vx = d.vy = 0;
  d.swapAt = s.time;
  ctx.stepSwarm(s, 0.05);
  assert.strictEqual(d.mode, 'ok', 'setup: the crew must relaunch it');
  assert.ok(d.batteryPct > 99, 'setup: on a fresh pack');
  s.c2.inbox.push({ src: d.id, payload: telemetry() });
  s.c2.nextCmd = 0;
  ctx.c2Step(s);
  assert.ok(!(s.c2.unfit[d.id] > s.time), 'C2 benched ' + d.id + ' on a full pack for a decline made on the old one');
  assert.ok(!s.events.some(e => e.msg.startsWith('C2: ' + d.id + ' declined')), 'logged a stale decline');
});
