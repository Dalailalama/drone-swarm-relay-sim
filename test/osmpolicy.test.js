// OSM usage policies. Nominatim allows "an absolute maximum of 1 request per
// second" per application and asks clients to cache; Overpass asks clients
// to back off after a 429/504. Before this, every Load click during
// geocoding sent another Nominatim request (5 clicks = 5 requests in ~57 ms),
// a repeated search was never cached, and a busy reply was retried at once.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');

function deferredFetch() {
  const pending = [];
  const fn = (url) => new Promise((resolve, reject) => pending.push({ url: String(url), resolve, reject }));
  fn.pending = pending;
  fn.calls = () => pending.length + fn.done;
  fn.done = 0;
  fn.resolveNext = (json, status) => {
    const p = pending.shift(); fn.done++;
    p.resolve({ ok: !status, status: status || 200, json: async () => json });
  };
  fn.rejectNext = (err) => { const p = pending.shift(); fn.done++; p.reject(err); };
  return fn;
}
const flush = () => new Promise(r => setImmediate(r));
const isNominatim = u => u.includes('nominatim.openstreetmap.org');

function osmUI() {
  const fetch = deferredFetch();
  const ui = loadUI({ fetch });
  ui.el('terrainSel').value = 'osm';
  ui.fire('terrainSel', 'change');
  return { ui, fetch };
}
// What a browser does: a click on a disabled button is never delivered.
const userClick = (ui, id) => { if (!ui.el(id).disabled) ui.fire(id, 'click'); };

test('Load clicks while a place search is pending send ONE Nominatim request', async () => {
  const { ui, fetch } = osmUI();
  ui.el('osmPlace').value = 'Some Town';
  for (let i = 0; i < 5; i++) { userClick(ui, 'osmLoadBtn'); await flush(); }
  assert.strictEqual(fetch.pending.filter(p => isNominatim(p.url)).length, 1, 'duplicate geocodes went out');
  assert.strictEqual(ui.el('osmLoadBtn').disabled, true, 'the search owns the button');
  fetch.rejectNext(new Error('offline'));
  await flush(); await flush();
  assert.strictEqual(ui.el('osmLoadBtn').disabled, false, 'button recovers after a failed search');
  assert.strictEqual(ui.el('osmLoadBtn').textContent, 'Load real area');
});

test('a successful place search hands the button straight to the area load', async () => {
  const { ui, fetch } = osmUI();
  ui.el('osmPlace').value = 'Some Town';
  userClick(ui, 'osmLoadBtn');
  await flush();
  fetch.resolveNext([{ lat: '28.63', lon: '77.21', display_name: 'Some Town, Somewhere' }]);
  await flush(); await flush();
  assert.strictEqual(fetch.pending.length, 1, 'Overpass request follows at once');
  assert.ok(!isNominatim(fetch.pending[0].url));
  assert.strictEqual(ui.el('osmLoadBtn').disabled, true);
  assert.strictEqual(ui.el('osmLoadBtn').textContent, 'Loading…');
});

test('back-to-back geocodes are spaced at least a second apart; repeats come from the cache', async () => {
  const { ui, fetch } = osmUI();
  const g1 = ui.ctx.osmGeocode('Alpha');
  await flush();
  assert.strictEqual(fetch.pending.length, 1, 'the first request is not delayed');
  fetch.resolveNext([{ lat: '1', lon: '2', display_name: 'Alpha' }]);
  assert.strictEqual((await g1).lat, 1);
  const timersBefore = ui.ctx.__timers.queue.length;
  const g2 = ui.ctx.osmGeocode('Beta');
  await flush();
  assert.strictEqual(fetch.calls(), 1, 'second Nominatim request sent inside the 1 s window');
  const gate = ui.ctx.__timers.queue.slice(timersBefore).find(t => !t.repeat);
  assert.ok(gate && gate.ms >= 1000 && gate.ms <= 1100, 'waits out the rest of the second (' + (gate && gate.ms) + ' ms)');
  ui.ctx.__timers.run();
  await flush();
  assert.strictEqual(fetch.pending.length, 1, 'sent once the window has passed');
  fetch.resolveNext([{ lat: '3', lon: '4', display_name: 'Beta' }]);
  assert.strictEqual((await g2).lat, 3);
  const again = await ui.ctx.osmGeocode('  alpha ');
  assert.strictEqual(fetch.calls(), 2, 'a repeated search must not hit Nominatim again');
  assert.deepStrictEqual([again.lat, again.lon, again.name], [1, 2, 'Alpha']);
});

test('Overpass busy replies (429/504) start a cooldown instead of an immediate retry', async () => {
  const { ui, fetch } = osmUI();
  const first = ui.ctx.osmFetchArea(28.63, 77.21, 800).then(() => null, e => e);
  await flush();
  fetch.resolveNext({}, 429);              // primary endpoint: too many requests
  await flush(); await flush();
  fetch.resolveNext({}, 504);              // fallback endpoint: gateway timeout
  const err = await first;
  assert.ok(err && /wait ~30 s/.test(err.message), 'tells the user to wait: ' + (err && err.message));
  const n = fetch.calls();
  const second = await ui.ctx.osmFetchArea(28.63, 77.21, 800).then(() => null, e => e);
  assert.strictEqual(fetch.calls(), n, 'a load inside the cooldown must not hit the servers');
  assert.ok(second && /wait ~\d+ s/.test(second.message), second && second.message);
});
