// Audit C2-10 follow-up: drones pace their reports on the interval C2
// ANNOUNCED, and keep the report they already scheduled when a shorter one
// arrives. C2's staleness timer, though, followed its live plan: when the
// chain plan shrank (the operator pulled the objective in), the window fell
// from 3 x 38 s to 3 x 9.6 s at once and C2 booked every drone lost — RF-bad
// paint, rescue dispatch — while their next reports were not even due.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const LORA = R.RADIOS.find(r => r.id === 'lora868');
const X8 = A.AIRFRAMES.find(a => a.id === 'x8');

function setup() {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 12, airframe: X8, radio: LORA, envFactor: 1,
    targetX: 9000, targetY: 0, altitudeM: 60, seed: 42 });
  const told = [];
  const real = ctx.sendBroadcast;
  ctx.sendBroadcast = (sim, src, payload, bytes, rad) => {
    if (src === 'C2' && payload.cadence) told.push(payload.cadence.tlmSec);
    return real(sim, src, payload, bytes, rad);
  };
  const round = () => { s.c2.nextCmd = 0; ctx.c2Step(s); };
  const reportAll = () => s.drones.forEach((d, i) => s.c2.inbox.push({ src: d.id, payload: {
    x: 100 + 10 * i, y: 0, gps: 'ok', battery: 90, role: 'mission', cls: 'mission', posAt: s.time } }));
  return { ctx, s, told, round, reportAll };
}

test('C2-10: C2 does not book drones lost before their next report is due on the cadence it announced', () => {
  const { s, told, round, reportAll } = setup();
  s.time = 100;
  reportAll();
  round();                                  // long chain planned, its report interval announced
  const tlm = told[told.length - 1];
  assert.ok(tlm > 30, 'setup: a 12-drone LoRa chain must pace reports slowly (' + tlm + ' s)');
  s.target.x = 300;                         // the operator pulls the objective in: no relays needed
  s.time = 105;
  round();                                  // shorter plan, shorter interval announced
  assert.ok(told[told.length - 1] < tlm / 3, 'setup: the announced interval must shrink');
  s.time = 100 + 0.9 * tlm;                 // every drone's next report is still due at 100 + tlm
  round();
  assert.deepStrictEqual(Object.keys(s.c2.lost), [], 'booked lost while still on the announced cadence');
  assert.ok(!s.events.some(e => /C2 lost telemetry/.test(e.msg)), 'reported a comms loss that never happened');
});

test('C2-10: once the old cadence has run out, real silence is still caught (guard)', () => {
  const { s, told, round, reportAll } = setup();
  s.time = 100;
  reportAll();
  round();
  const tlm = told[told.length - 1];
  s.target.x = 300;
  s.time = 105;
  round();
  s.time = 100 + 3 * tlm + 1;               // three old intervals of silence: they are gone
  round();
  assert.strictEqual(Object.keys(s.c2.lost).length, s.drones.length, 'silent drones must be booked lost');
});
