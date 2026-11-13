// Finding #26 (review of ffb35e6, B42): CoT export stamped the planned AGL
// straight into hae= — height above ELLIPSOID. With a vehicle at 120 m AGL
// and an origin at 500 m HAE the export said hae="50.0" (the altitude
// slider). The vertical datum must be defined: anchor HAE + local absolute
// altitude (terrain + AGL), and an UNKNOWN origin sends TAK's unknown hae
// rather than inventing one.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore(['osm.js', 'tak.js']);
const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const T = require('../js/tak.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function mk(terrain) {
  const s = ctx.makeSwarm({
    count: 2, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 500, targetY: 0, altitudeM: 50, seed: 42,
  });
  if (terrain) { s.terrain = ctx.makeTerrain(terrain, { distM: 500, targetX: 500, targetY: 0, seed: 9 }); }
  return s;
}

function haeOfAtom(atoms, uid) {
  const atom = atoms.find(a => a.includes('uid="' + uid + '"'));
  assert.ok(atom, uid + ' atom must exist');
  const m = atom.match(/hae="([^"]*)"/);
  return m ? parseFloat(m[1]) : null;
}

test('regression #26: hae = origin HAE + terrain + AGL, not the altitude slider', () => {
  const s = mk(null); // flat ground
  const d = s.drones[0];
  d.altM = 120; // externally-reported AGL — the reviewer's probe
  const anchor = T.makeTakAnchor(38.8977, -77.0365, 0, 0, 500);
  const atoms = ctx.buildCotFromSwarm(s, anchor);
  const hae = haeOfAtom(atoms, 'SIM-' + d.id);
  assert.ok(Math.abs(hae - 620) < 0.6,
    'expected hae ~620 (500 origin + 0 ground + 120 AGL), got ' + hae);
});

// Audit tak-hae-omitted-schema-invalid: omitting hae was schema-invalid
// (point.xsd requires it); unknown is TAK's 9999999 sentinel instead.
test('regression #26: an UNKNOWN origin altitude sends TAK unknown hae instead of inventing it', () => {
  const s = mk(null);
  const anchor = T.makeTakAnchor(38.8977, -77.0365, 0, 0); // no HAE known
  const atoms = ctx.buildCotFromSwarm(s, anchor);
  for (const a of atoms) {
    assert.ok(/hae="9999999\.0"/.test(a), 'atom invented an hae with no vertical datum: ' + a.slice(0, 120));
  }
});

// Review: main.js takAnchor() still said a blank origin HAE makes exports
// omit hae — they send TAK's unknown value since the schema fix above. The
// page's own export path and the comment that describes it must agree.
test('the page exports TAK unknown hae for a blank origin HAE, as takAnchor() documents', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { loadUI } = require('./helpers/dom.js');
  const { ctx: ui, el } = loadUI();
  el('takHae').value = '';
  el('takExportBtn').click();
  const out = ui.__downloads.find(d => /^cot-snapshot/.test(d.name));
  assert.ok(out, 'the CoT snapshot downloaded');
  const points = out.text.match(/<point [^>]*>/g) || [];
  assert.ok(points.length > 0, 'snapshot has points');
  for (const p of points) assert.match(p, /hae="9999999\.0"/, p);
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
  const body = src.slice(src.indexOf('function takAnchor()'), src.indexOf('function syncTakOrigin()'));
  assert.ok(body.length > 0, 'takAnchor() found in main.js');
  assert.doesNotMatch(body, /omit\w*\s+hae/i, 'takAnchor() comment says exports omit hae');
});

test('terrain-following drones export terrain + AGL over hills', () => {
  const s = mk('rolling');
  const d = s.drones[0];
  d.x = 300; d.y = -50;
  const ground = ctx.terrainGroundAt(s.terrain, d.x, d.y);
  const anchor = T.makeTakAnchor(38.8977, -77.0365, 0, 0, 100);
  const atoms = ctx.buildCotFromSwarm(s, anchor);
  const hae = haeOfAtom(atoms, 'SIM-' + d.id);
  assert.ok(Math.abs(hae - (100 + ground + 50)) < 0.6,
    'expected 100 + ' + ground.toFixed(1) + ' + 50, got ' + hae);
});
