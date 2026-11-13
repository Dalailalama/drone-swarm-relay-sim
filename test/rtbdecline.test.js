// Declines logged on the way home (review). A drone already committed to
// RTB still ran the commitment rule on every order it heard and logged
// "declines <role> tasking" while flying home (seen in ddil-denied and
// ddil-disrupted) — noise for orders it cannot take anyway. An RTB drone has
// nothing to decline: the order is still not taken, but there is no log
// line and no decline latched (RTB stops telemetry and a relaunch clears the
// latch, so C2 never heard of these declines in the first place).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function setup(mode) {
  const s = ctx.makeSwarm({ count: 4, airframe: Q450, radio: SIK, envFactor: 1, targetX: 300, targetY: 0, seed: 3 });
  const d = s.drones[0];
  s.time = 1;
  d.mode = mode;
  return { s, d };
}

function deliver(s, d, order) {
  d.inbox.push({ kind: 'cmd', src: 'C2', dst: d.id, payload: order });
  ctx.droneComms(s, d);
}

function farRelay(s) {
  return { role: 'relay', slot: 0, k: 1, upstream: 'C2', slotPos: { x: 20000, y: 0 },
    c2: { x: s.base.x, y: s.base.y, at: s.time }, target: { x: s.target.x, y: s.target.y } };
}

const declines = (s, d) => s.events.filter(e => e.msg.startsWith(d.id + ' declines'));

test('an RTB drone neither logs nor latches a decline for an order it cannot take', () => {
  const { s, d } = setup('rtb');
  const seq0 = d.rejectSeq;
  deliver(s, d, farRelay(s));
  assert.strictEqual(d.order.role, 'mission', 'the order must still not be taken');
  assert.strictEqual(declines(s, d).length, 0,
    'logged a decline while flying home: ' + declines(s, d).map(e => e.msg).join(' | '));
  assert.strictEqual(d.rejectSeq, seq0, 'counted a decline while flying home');
  assert.strictEqual(d.rejectedRole, null, 'latched a decline while flying home');
});

test('a drone still on task declines and logs the same order (guard)', () => {
  const { s, d } = setup('ok');
  const seq0 = d.rejectSeq;
  deliver(s, d, farRelay(s));
  assert.strictEqual(d.order.role, 'mission');
  assert.strictEqual(declines(s, d).length, 1);
  assert.strictEqual(d.rejectSeq, seq0 + 1);
  assert.strictEqual(d.rejectedRole, 'relay');
});
