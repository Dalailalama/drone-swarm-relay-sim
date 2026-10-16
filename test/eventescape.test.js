// Audit finding ui-render/event-log-double-escape: the real-area loader stored
// escHtml(area.name) in the event, and the event log escapes again when it
// renders, so 'Barnes & Noble' showed as 'Barnes &amp; Noble' in the log and
// in the after-action report (which copies event text verbatim). Events hold
// raw text; rendering escapes.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI, makeFile } = require('./helpers/dom.js');

const flush = () => new Promise(r => setImmediate(r));

function overpassJson(lat, lon) {
  const d = 0.0004;
  return { elements: [{ type: 'way', tags: { height: '25' }, geometry: [
    { lat: lat + d, lon: lon - d }, { lat: lat + d, lon: lon + d },
    { lat: lat - d, lon: lon + d }, { lat: lat - d, lon: lon - d },
  ] }] };
}

test('a place name with & is stored raw in the event log', async () => {
  const sc = { version: 1, env: 'open', airframe: 'q450', count: 4, terrain: 'osm', seed: 5,
    osm: { lat: 40.736, lon: -73.990, radiusM: 800, name: 'Barnes & Noble, Union Square' }, jammers: [] };
  const fetch = async () => ({ ok: true, json: async () => overpassJson(sc.osm.lat, sc.osm.lon) });
  const ui = loadUI({ fetch });
  ui.el('loadScenarioInput').files = [makeFile('s.json', JSON.stringify(sc))];
  ui.fire('loadScenarioInput', 'change');
  for (let i = 0; i < 4; i++) await flush();
  const ev = ui.ctx.sim.swarm.events.find(e => /^Real area loaded/.test(e.msg));
  assert.ok(ev, 'area loaded event: ' + JSON.stringify(ui.ctx.sim.swarm.events.map(e => e.msg)));
  assert.match(ev.msg, /Barnes & Noble/);
  assert.doesNotMatch(ev.msg, /&amp;/);
});
