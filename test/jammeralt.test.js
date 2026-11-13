// One antenna height for an interference source (review). A source that
// named no altM sat 15 m up in the interference floor, 2 m up for a red-team
// hunter's DF receiver and 0 m up on the TAK hazard mark, and the floor's
// `altM || 15` also lifted an explicit ground-level source (altM 0) to 15 m.
// Every reader now takes the source's own altM, or one shared default.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const T = require('../js/tak.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function mk(ctx, extra) {
  return ctx.makeSwarm(Object.assign({
    count: 2, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 7,
  }, extra || {}));
}

test('an explicit ground-level source (altM 0) is not lifted to the default mast', () => {
  const ctx = loadCore();
  const s = mk(ctx);
  const rx = { x: 20, y: 0 };
  const floor = altM => ctx.interferenceFloorDbm(s, rx, 15, SIK, null,
    [{ id: 'JX-g', x: 0, y: 0, erpDbm: 0, band: 'all', altM, on: true }]);
  assert.ok(floor(0) < floor(15) - 1,
    'a source on the ground 20 m off a 15 m receiver must arrive weaker than one level with it: ' +
    floor(0).toFixed(2) + ' vs ' + floor(15).toFixed(2) + ' dBm');
});

test('a source with no altM sits at one height for the RF floor and a hunter’s DF receiver', () => {
  const ctx = loadCore();
  const s = mk(ctx, { adversaryMode: true,
    jammers: [{ id: 'JX-h', x: 500, y: 0, erpDbm: 10, band: 'all', on: true }] });
  const j = s.jammers[0];
  const seen = [];
  const los = ctx.losBlocked;
  ctx.losBlocked = (terrain, x1, y1, z1, ...rest) => {
    if (x1 === j.x && y1 === j.y) seen.push(z1);
    return los(terrain, x1, y1, z1, ...rest);
  };
  try {
    ctx.interferenceFloorDbm(s, { x: 0, y: 0 }, 6, SIK);
    s.net.txAt = { C2: s.time }; // the ground station just keyed up
    ctx.stepAdversaries(s, 0.05);
  } finally { ctx.losBlocked = los; }
  assert.strictEqual(seen.length, 2, 'the floor and the DF fix each test terrain LOS from the source');
  assert.strictEqual(seen[1], seen[0], 'DF receiver at ' + seen[1] + ' m, interference emitter at ' + seen[0] + ' m');
});

test('the TAK hazard mark of a source with no altM carries the same height as the RF model', () => {
  const ctx = loadCore(['osm.js', 'tak.js']);
  const s = mk(ctx, { jammers: [{ id: 'JX-1', x: 300, y: 0, erpDbm: 24, band: 'all', on: true }] });
  const seen = [];
  const los = ctx.losBlocked;
  ctx.losBlocked = (terrain, x1, y1, z1, ...rest) => { seen.push(z1); return los(terrain, x1, y1, z1, ...rest); };
  try { ctx.interferenceFloorDbm(s, { x: 0, y: 0 }, 6, SIK); } finally { ctx.losBlocked = los; }
  const anchor = T.makeTakAnchor(38.8977, -77.0365, 0, 0, 500);
  const atom = ctx.buildCotFromSwarm(s, anchor).find(a => a.includes('uid="SIM-JX-1"'));
  assert.ok(atom, 'the source must be exported as a hazard');
  const hae = parseFloat(atom.match(/hae="([^"]*)"/)[1]);
  assert.ok(Math.abs(hae - (500 + seen[0])) < 0.06, 'hazard hae ' + hae + ', RF model emitter at ' + seen[0] + ' m above flat ground');
});
