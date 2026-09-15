// Finding #8 (review of ffb35e6, B36): cancelling a stale OSM fetch by
// returning early still RESOLVES its promise, so the stale applyScenario's
// unconditional .then(applyMissionOverrides) replayed scenario A's mission
// onto freshly-loaded scenario B (target reverted 888,999 -> 111,222 in the
// reviewer's probe) — and the stale finally left the Load button disabled.
// Geocoding and manual relaunch weren't cancellation points at all.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI, makeFile } = require('./helpers/dom.js');

// A controllable fetch: every call parks until the test resolves it.
function deferredFetch() {
  const pending = [];
  const fn = (url) => new Promise((resolve, reject) => pending.push({ url: String(url), resolve, reject }));
  fn.pending = pending;
  fn.resolveNext = (json) => {
    const p = pending.shift();
    p.resolve({ ok: true, json: async () => json });
  };
  return fn;
}

const flush = () => new Promise(r => setImmediate(r));

// One parseable building near the queried coordinates.
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

const A = { version: 1, env: 'open', airframe: 'q450', count: 4, altitudeM: 60, spacingPct: 80,
  terrain: 'osm', seed: 5, osm: { lat: 28.63, lon: 77.21, radiusM: 800, name: 'A-town' },
  target: { x: 111, y: 222 }, jammers: [] };
const B = { version: 1, env: 'open', airframe: 'q450', count: 4, altitudeM: 60, spacingPct: 80,
  terrain: 'flat', seed: 6, target: { x: 888, y: 999 }, jammers: [] };

test('regression #8: a stale OSM fetch cannot replay its scenario onto a newer one', async () => {
  const fetch = deferredFetch();
  const ui = loadUI({ fetch });
  loadScenario(ui, A);            // A starts its OSM fetch...
  assert.strictEqual(fetch.pending.length, 1, 'A must be fetching');
  loadScenario(ui, B);            // ...user loads B while A is in flight
  assert.strictEqual(ui.ctx.sim.swarm.target.x, 888);
  fetch.resolveNext(overpassJson(A.osm.lat, A.osm.lon)); // A's data finally lands
  await flush(); await flush();
  assert.strictEqual(ui.ctx.sim.swarm.target.x, 888,
    'stale scenario A replayed its target onto B (x=' + ui.ctx.sim.swarm.target.x + ')');
  assert.strictEqual(ui.ctx.sim.swarm.target.y, 999);
  assert.ok(!ui.ctx.sim.swarm.terrain.geoAnchor, 'B is not an OSM scenario — A\'s map must not appear');
});

test('regression #8: the Load button recovers after its fetch is superseded', async () => {
  const fetch = deferredFetch();
  const ui = loadUI({ fetch });
  loadScenario(ui, A);
  assert.strictEqual(ui.el('osmLoadBtn').disabled, true, 'loading state engaged');
  loadScenario(ui, B);            // supersedes A's fetch
  fetch.resolveNext(overpassJson(A.osm.lat, A.osm.lon));
  await flush(); await flush();
  assert.strictEqual(ui.el('osmLoadBtn').disabled, false,
    'Load button left stuck disabled by the superseded fetch');
  assert.strictEqual(ui.el('osmLoadBtn').textContent, 'Load real area');
});

test('regression #8: a scenario load during GEOCODING cancels the area load behind it', async () => {
  const fetch = deferredFetch();
  const ui = loadUI({ fetch });
  ui.el('terrainSel').value = 'osm';
  ui.fire('terrainSel', 'change');
  ui.el('osmPlace').value = 'Some Town';   // a name, so the geocoder runs first
  ui.fire('osmLoadBtn', 'click');
  await flush();
  assert.strictEqual(fetch.pending.length, 1, 'geocode request in flight');
  loadScenario(ui, B);                      // user moves on while geocoding
  fetch.resolveNext([{ lat: '28.63', lon: '77.21', display_name: 'Some Town' }]);
  await flush(); await flush();
  assert.strictEqual(fetch.pending.length, 0,
    'geocode completion still launched a building fetch for an abandoned request');
  assert.strictEqual(ui.ctx.sim.swarm.target.x, 888, 'scenario B undisturbed');
});

test('regression #8: manual relaunch cancels a pending area load', async () => {
  const fetch = deferredFetch();
  const ui = loadUI({ fetch });
  loadScenario(ui, A);
  assert.strictEqual(fetch.pending.length, 1);
  ui.fire('resetBtn', 'click');             // operator relaunches — old fetch is moot
  fetch.resolveNext(overpassJson(A.osm.lat, A.osm.lon));
  await flush(); await flush();
  assert.ok(!ui.ctx.sim.swarm.terrain.geoAnchor,
    'a relaunch-superseded fetch still installed its map');
  assert.strictEqual(ui.el('osmLoadBtn').disabled, false, 'button must recover');
});
