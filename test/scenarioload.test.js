// Soak-audit finding R6 (issue #25): the scenario loader copied base,
// target, jammers and GPS zones straight into the running swarm with no
// type checks (only radio presets were sanitized, finding #7). Numeric
// STRINGS then concatenated: `s.target.x += vel*dt` appended "0" every tick
// ("500000…0" -> Infinity) and drone x became a string; a string jammer x
// became "250NaNNaN…" under adversary mode. A null entry threw only AFTER
// the controls were reset and the swarm relaunched with the file's settings,
// so "Bad scenario file" left a half-applied scenario behind.
// The file must be validated in full before anything changes.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI, makeFile } = require('./helpers/dom.js');
const { SCENARIO_PACK } = require('../js/scenarios.js');
const { MISSION_LIBRARY } = require('../js/missions.js');

const GOOD = { version: 1, radio: 'sik-v3', env: 'open', airframe: 'q450', count: 6, altitudeM: 60, spacingPct: 80,
  terrain: 'flat', seed: 11, base: { x: 0, y: 0 }, target: { x: 500, y: -120 }, jammers: [], gpsZones: [] };

const BAD = {
  'target numeric strings': { target: { x: '500', y: '-120' } },
  'base numeric strings': { base: { x: '10', y: '5' } },
  'target null coords': { target: { x: null, y: 0 } },
  'jammer string coords': { adversaryMode: true, jammers: [{ x: '250', y: '0', erpDbm: 20, band: 'all', altM: 15, on: true }] },
  'jammer null entry': { count: 9, jammers: [null] },
  'jammers not an array': { jammers: { x: 1 } },
  'jammer without power': { jammers: [{ x: 250, y: 0 }] },
  'jammer garbage band': { jammers: [{ x: 250, y: 0, erpDbm: 30, band: 'foo', on: true }] },
  'zone string radius': { gpsZones: [{ x: 250, y: 0, rM: 'big', on: true }] },
  'zone null entry': { gpsZones: [null] },
  'moving base strings': { baseVelMps: { x: '5', y: 0 } },
  'count not a number': { count: 'abc' },
  'toggle not a boolean': { corridor: 'yes' },
};

for (const [name, patch] of Object.entries(BAD)) {
  test('R6: "' + name + '" is rejected before anything changes', () => {
    const { ctx, el, fire } = loadUI();
    for (let i = 0; i < 3; i++) ctx.__raf.pump(200);
    const before = { swarm: ctx.sim.swarm, n: ctx.sim.swarm.drones.length, count: el('countRange').value, radio: el('radioSel').value,
      terrain: el('terrainSel').value, alt: el('altRange').value, target: { ...ctx.sim.swarm.target } };
    el('loadScenarioInput').files = [makeFile('bad.json', JSON.stringify(Object.assign({}, GOOD, patch)))];
    fire('loadScenarioInput', 'change');
    assert.strictEqual(ctx.__alerts.length, 1, 'exactly one "Bad scenario file" alert, got ' + JSON.stringify(ctx.__alerts));
    assert.match(ctx.__alerts[0], /^Bad scenario file: /);
    assert.strictEqual(ctx.sim.swarm, before.swarm, 'the running mission must not be relaunched');
    assert.strictEqual(ctx.sim.swarm.drones.length, before.n);
    assert.ok(ctx.sim.swarm.target.x === before.target.x && ctx.sim.swarm.target.y === before.target.y, 'the objective must not move');
    assert.strictEqual(el('countRange').value, before.count, 'controls must not be reset');
    assert.strictEqual(el('radioSel').value, before.radio);
    assert.strictEqual(el('terrainSel').value, before.terrain);
    assert.strictEqual(el('altRange').value, before.alt);
    for (let i = 0; i < 5; i++) ctx.__raf.pump(200);
    for (const d of ctx.sim.swarm.drones) assert.strictEqual(typeof d.x, 'number', d.id + '.x became ' + typeof d.x);
  });
}

test('R6: every shipped pack and mission, and a save->load round trip, still load cleanly', () => {
  const { ctx, el, fire } = loadUI();
  SCENARIO_PACK.forEach((p, i) => { el('packSel').value = String(i); fire('packSel', 'change'); el('loadPackBtn').click(); });
  MISSION_LIBRARY.forEach((m, i) => { el('missionSel').value = String(i); fire('missionSel', 'change'); el('loadMissionBtn').click(); });
  assert.deepStrictEqual(ctx.__alerts, []);
  el('saveScenarioBtn').click();
  const saved = ctx.__downloads[ctx.__downloads.length - 1].text;
  el('loadScenarioInput').files = [makeFile('rt.json', saved)];
  fire('loadScenarioInput', 'change');
  assert.deepStrictEqual(ctx.__alerts, [], 'a file the app itself saved must load');
  assert.strictEqual(ctx.sim.swarm.drones.length, JSON.parse(saved).count);
});
