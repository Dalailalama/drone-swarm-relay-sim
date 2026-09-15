// Findings #22/#32 (review of ffb35e6, B35/B37): the two SECONDARY rebuild
// paths ignored the fixed geometry handling of the main one —
//  #22: after a successful OSM fetch, resetSwarm() ran with neither the
//       saved seed nor base/target: drones spawned at the default origin
//       with a random seed while the overrides merely repainted the target;
//  #32: the city sliders regenerated terrain from ORIGIN distance, dropped
//       the moved base entirely, and `seed || 42` erased seed 0.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI, makeFile } = require('./helpers/dom.js');

function deferredFetch() {
  const pending = [];
  const fn = (url) => new Promise((resolve, reject) => pending.push({ url: String(url), resolve, reject }));
  fn.pending = pending;
  fn.resolveNext = (json) => { const p = pending.shift(); p.resolve({ ok: true, json: async () => json }); };
  return fn;
}
const flush = () => new Promise(r => setImmediate(r));

function overpassJson(lat, lon) {
  const d = 0.0004;
  return { elements: [{ type: 'way', tags: { height: '25' }, geometry: [
    { lat: lat + d, lon: lon - d }, { lat: lat + d, lon: lon + d },
    { lat: lat - d, lon: lon + d }, { lat: lat - d, lon: lon - d },
  ] }] };
}

function loadScenario(ui, sc) {
  ui.fire('loadScenarioBtn', 'click');
  ui.el('loadScenarioInput').files = [makeFile('scenario.json', JSON.stringify(sc))];
  ui.fire('loadScenarioInput', 'change');
}

test('regression #22: the post-fetch OSM rebuild keeps the scenario seed and geometry', async () => {
  const fetch = deferredFetch();
  const ui = loadUI({ fetch });
  loadScenario(ui, {
    version: 1, radio: 'sik-v3', env: 'open', airframe: 'q450', count: 4,
    altitudeM: 60, spacingPct: 80, terrain: 'osm', seed: 7,
    osm: { lat: 28.63, lon: 77.21, radiusM: 800, name: 'A-town' },
    base: { x: 1000, y: 2000 }, target: { x: 1500, y: 2000 }, jammers: [],
  });
  fetch.resolveNext(overpassJson(28.63, 77.21));
  await flush(); await flush();
  const s = ui.ctx.sim.swarm;
  assert.strictEqual(s._terrainSeed, 7, 'rebuild lost the saved seed (got ' + s._terrainSeed + ')');
  assert.strictEqual(s.base.x, 1000, 'rebuild lost the moved base');
  assert.strictEqual(s.target.x, 1500);
  const d0 = s.drones[0];
  const spawnDist = Math.hypot(d0.x - 1000, d0.y - 2000);
  assert.ok(spawnDist < 150,
    'drones must spawn around the SAVED base, not the origin (DR-1 is ' + spawnDist.toFixed(0) + ' m away)');
  assert.ok(s.terrain.geoAnchor, 'the fetched map must be installed');
});

test('regression #32: city sliders regenerate around the real corridor with the real seed', () => {
  const ui = loadUI();
  loadScenario(ui, {
    version: 1, radio: 'sik-v3', env: 'open', airframe: 'q450', count: 4,
    altitudeM: 60, spacingPct: 80, terrain: 'urban', seed: 0, // seed ZERO on purpose
    cityDensity: 60, cityHeight: 40,
    base: { x: 500, y: 500 }, target: { x: 1100, y: 500 }, jammers: [],
  });
  const s = ui.ctx.sim.swarm;
  assert.strictEqual(s._terrainSeed, 0, 'precondition: scenario seed 0 must load as 0');
  ui.el('cityDensityRange').value = '80';
  ui.fire('cityDensityRange', 'input'); // live regeneration
  assert.strictEqual(s.terrain.seed, 0,
    'regeneration replaced seed 0 with ' + s.terrain.seed);
  const bs = s.terrain.buildings;
  assert.ok(bs.length > 10, 'a dense city must regenerate buildings');
  const mx = bs.reduce((a, b) => a + b.x, 0) / bs.length;
  const my = bs.reduce((a, b) => a + b.y, 0) / bs.length;
  // The city belongs on the base->target corridor (midpoint 800,500) — not
  // centred on a corridor from the origin (whose midpoint is 550,250).
  assert.ok(Math.abs(my - 500) < 150,
    'regenerated city ignored the moved base (mean building y=' + my.toFixed(0) + ', corridor y=500)');
  assert.ok(Math.abs(mx - 800) < 300,
    'regenerated city off-corridor (mean x=' + mx.toFixed(0) + ', midpoint 800)');
});
