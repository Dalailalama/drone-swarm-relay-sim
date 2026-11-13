// Audit C2-04: an RTB drone stops beaconing after the one 'rtb' report it
// sends at the transition. When it then went quiet, C2's fresh->stale branch
// ignored the role it KNEW, booked the homebound drone as lost, painted its
// last position RF-bad and launched rescue chains after it.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('C2-04: a drone C2 knows is RTB is not booked lost, painted bad or chased', () => {
  const s = ctx.makeSwarm({ count: 6, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42 });
  while (s.time < 90) ctx.stepSwarm(s, 0.25);
  const d = s.drones.find(x => x.mode === 'ok' && x.order.role === 'mission' && s.c2.known[x.id] &&
    s.time - s.c2.known[x.id].at < 5);
  assert.ok(d, 'need a mission drone in contact');
  // Battery at the reserve floor: the onboard smart-RTH turns it home next tick.
  d.energyWh = ctx.usableWh(Q450) * 0.07;
  let lastRtbPos = null;
  const badAt = new Map();
  for (const [k, e] of s.c2.cov) badAt.set(k, e.bad);
  let rescued = false, everLost = false;
  while (s.time < 200) {
    ctx.stepSwarm(s, 0.25);
    const k = s.c2.known[d.id];
    if (k && k.role === 'rtb') lastRtbPos = { x: k.x, y: k.y };
    if (s.c2.rescuers.length) rescued = true;
    if (d.id in s.c2.lost) everLost = true;
  }
  assert.ok(lastRtbPos, 'C2 must have received the RTB report');
  assert.ok(!everLost, 'C2 booked homebound ' + d.id + ' as lost');
  assert.ok(!s.events.some(e => e.msg === 'C2 lost telemetry from ' + d.id),
    'C2 reported an expected RTB silence as a comms loss');
  const key = ctx.covKey(s, lastRtbPos.x, lastRtbPos.y);
  const e = s.c2.cov.get(key);
  assert.strictEqual(e ? e.bad : 0, badAt.get(key) || 0, 'RTB silence painted the RF map bad');
  assert.ok(!rescued, 'rescue chain launched after a homebound drone');
});
