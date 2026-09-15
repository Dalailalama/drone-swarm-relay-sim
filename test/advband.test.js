// Finding #20 (review of ffb35e6, B20): adversary DF sensing used a band
// representation nothing else uses — jammer.band is a NUMBER (MHz) or 'all'
// everywhere else, but the hunter branch only understood the strings
// '2.4g'/'5g' and mapped everything else to 915 MHz, so a 2400 MHz hunter
// ignored a 2400 MHz emitter right next to it. And observations recomputed
// the emitter's CURRENT position every tick, so a hunter kept perfect track
// of a target that had gone silent. Bands must normalize to MHz everywhere,
// and a DF fix is a measurement taken at emission time, kept as taken.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const ESP = R.RADIOS.find(r => r.id === 'espnow'); // 2400 MHz
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function mk() {
  const s = ctx.makeSwarm({
    count: 2, airframe: Q450, radio: ESP, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
  s.adversaryMode = true;
  s.advStats = s.advStats || { movedM: 0 };
  return s;
}

test('regression #20: a 2400 MHz hunter senses a 2400 MHz emitter', () => {
  const s = mk();
  s.jammers.push({ id: 'JX-h', x: 0, y: 800, erpDbm: 10, band: 2400, altM: 15, on: true, moveSpeedMs: 9 });
  const d = s.drones[0];
  d.x = 300; d.y = 0;
  s.net.txAt[d.id] = s.time; // the emitter just transmitted nearby
  const j = s.jammers[0];
  const before = { x: j.x, y: j.y };
  for (let i = 0; i < 8; i++) { s.time += 0.25; ctx.stepAdversaries(s, 0.25); }
  const moved = Math.hypot(j.x - before.x, j.y - before.y);
  assert.ok(moved > 5,
    'hunter ignored an in-band emitter (moved ' + moved.toFixed(1) + ' m)');
});

test('out-of-band traffic stays invisible to the hunter (guard)', () => {
  const s = mk(); // fleet radio 2400 MHz
  s.jammers.push({ id: 'JX-s', x: 0, y: 800, erpDbm: 10, band: 915, altM: 15, on: true, moveSpeedMs: 9 });
  const d = s.drones[0];
  d.x = 300; d.y = 0;
  s.net.txAt[d.id] = s.time;
  const j = s.jammers[0];
  const before = { x: j.x, y: j.y };
  for (let i = 0; i < 8; i++) { s.time += 0.25; ctx.stepAdversaries(s, 0.25); }
  assert.ok(Math.hypot(j.x - before.x, j.y - before.y) < 1,
    'a sub-GHz hunter must not see 2.4 GHz traffic');
});

test('regression #20: a silent emitter is tracked by its LAST fix, not its live position', () => {
  const s = mk();
  s.jammers.push({ id: 'JX-t', x: 0, y: 0, erpDbm: 10, band: 'all', altM: 15, on: true, moveSpeedMs: 9 });
  const d = s.drones[0];
  d.x = 900; d.y = 0;
  s.net.txAt[d.id] = s.time; // one emission at (900, 0), then silence
  const j = s.jammers[0];
  for (let i = 0; i < 3; i++) { s.time += 0.25; ctx.stepAdversaries(s, 0.25); }
  d.x = 900; d.y = 1500; // flies away without transmitting again
  for (let i = 0; i < 40; i++) { s.time += 0.25; ctx.stepAdversaries(s, 0.25); }
  // The hunter should be heading toward the recorded fix near (900, 0). If
  // it re-measured the silent drone's live position, its heading tilts up
  // toward (900, 1500) — slope ~1.67 instead of ~0.
  assert.ok(j.x > 50, 'hunter should have closed toward the last fix (x=' + j.x.toFixed(0) + ')');
  assert.ok(j.y < j.x * 0.5,
    'hunter heading tilted toward a SILENT emitter\'s live position (x=' + j.x.toFixed(0) + ', y=' + j.y.toFixed(0) + ')');
});
