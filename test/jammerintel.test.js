// Audit C2-09: in red-team mode the hostile emitters move in truth
// (stepAdversaries), yet C2's planner read their live positions straight off
// s.jammers: a hunter that crawled onto the corridor was dodged the instant it
// arrived, with C2's beliefs byte-identical. C2 now plans against where the
// emitters were reported; a hunter's move reaches C2 only the way any dead
// zone does, through lost telemetry and black-box uploads.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const LORA = R.RADIOS.find(r => r.id === 'lora868');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function swarm(adversaryMode) {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 12, airframe: Q450, radio: LORA, envFactor: 1, targetX: 8000, targetY: 0, seed: 5,
    adversaryMode, jammers: [{ id: 'JX-1', x: 5000, y: 3000, erpDbm: -5, band: 'all', altM: 15, on: true }] });
  return { ctx, s };
}

const key = plan => plan.slots.map(p => Math.round(p.x) + ',' + Math.round(p.y)).join(' ');

test('C2-09: a red-team hunter moving onto the corridor does not move C2\'s plan by itself', () => {
  const { ctx, s } = swarm(true);
  const before = key(ctx.planChain(s));
  s.jammers[0].x = 4000; s.jammers[0].y = 0; // the hunter's own move, in truth only
  s.time += 6;                                // past replanSec
  const after = key(ctx.planChain(s));
  assert.strictEqual(after, before, 'C2 dodged the hunter\'s new true position with no observation of it');
});

test('C2-09: an operator-placed source is planned around at once (guard)', () => {
  const { ctx, s } = swarm(false);
  const before = key(ctx.planChain(s));
  s.jammers[0].x = 4000; s.jammers[0].y = 0; // the operator dragged it onto the corridor
  s.time += 6;
  const after = key(ctx.planChain(s));
  assert.notStrictEqual(after, before, 'operator intel must reach the planner');
});

test('C2-09: in red-team mode a newly placed hunter is known where it was placed (guard)', () => {
  const { ctx, s } = swarm(true);
  const before = key(ctx.planChain(s));
  s.jammers.push({ id: 'JX-2', x: 4000, y: 0, erpDbm: -5, band: 'all', altM: 15, on: true });
  s.time += 6;
  const after = key(ctx.planChain(s));
  assert.notStrictEqual(after, before, 'a placement report must reach the planner');
});
