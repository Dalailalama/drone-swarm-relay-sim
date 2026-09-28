// Soak-audit findings R15/R16 (issue #20).
//  R15: the page's "Replay capture" button always failed — replay.js's
//       browser branch read window.RADIOS / window.AIRFRAMES, but radios.js
//       and airframes.js declare them as top-level `const` (not window
//       properties), so every replay died with "reading 'nFit'".
//  R16: the capture header did not describe the mission it came from:
//       jammers, GPS zones, the relay wing, shadowing, moving-mission
//       velocities and the real terrain (recorded as 'flat' for every map)
//       were missing, so a replay diverged within seconds.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI, makeFile } = require('./helpers/dom.js');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { replayMission } = require('../js/replay.js');

function maxPositionError(a, b) {
  let worst = 0;
  for (const d of a.drones) {
    const p = b.dronePositions.find(x => x.id === d.id);
    assert.ok(p, d.id + ' missing from the replay');
    worst = Math.max(worst, Math.hypot(p.x - d.x, p.y - d.y));
    assert.strictEqual(p.mode, d.mode, d.id + ' mode diverged');
  }
  return worst;
}

test('R15: the Replay capture button replays an exported capture in the page', () => {
  const { ctx, el, fire } = loadUI();
  el('captureChk').click();
  for (let i = 0; i < 20; i++) ctx.__raf.pump(200);
  el('exportBtn').click();
  const dl = ctx.__downloads[ctx.__downloads.length - 1];
  assert.ok(dl && /\.jsonl$/.test(dl.name) && dl.text, 'capture export must produce a .jsonl download');
  el('replayInput').files = [makeFile(dl.name, dl.text)];
  fire('replayInput', 'change');
  assert.deepStrictEqual(ctx.__alerts, [], 'replay must not fail');
  assert.ok(ctx.sim.swarm.events.some(e => /Replayed capture/.test(e.msg)), 'replay result must be reported');
});

test('R16: a UI mission with jammer, GPS zone, relay wing and shadowing replays exactly', () => {
  const { ctx, el, fire } = loadUI();
  const sc = {
    version: 1, radio: 'sik-v3', env: 'suburban', airframe: 'q450', count: 6, altitudeM: 60, spacingPct: 80,
    terrain: 'urban', cityDensity: 55, cityHeight: 45, seed: 77,
    hetero: true, relayWing: 2, relayAirframe: 'x8', relayRadio: 'rfd900x',
    base: { x: 0, y: 0 }, target: { x: 420, y: -160 }, windSpd: 3, windDir: 40,
    jammers: [{ x: 210, y: -60, erpDbm: 18, band: 'all', altM: 15, on: true }],
    gpsZones: [{ x: 300, y: -120, rM: 120, on: true }],
  };
  el('loadScenarioInput').files = [makeFile('ui.json', JSON.stringify(sc))];
  fire('loadScenarioInput', 'change');
  assert.deepStrictEqual(ctx.__alerts, []);
  el('captureChk').click();
  for (let i = 0; i < 25; i++) ctx.__raf.pump(200);
  const s = ctx.sim.swarm;
  el('exportBtn').click();
  const text = ctx.__downloads[ctx.__downloads.length - 1].text;
  const meta = JSON.parse(text.split('\n')[0]);
  assert.strictEqual(meta.settings.terrain, 'urban', 'the real terrain must be recorded');
  assert.strictEqual((meta.settings.jammers || []).length, 1, 'scenario jammers must be in the header');
  assert.strictEqual((meta.settings.gpsZones || []).length, 1, 'scenario GPS zones must be in the header');
  assert.strictEqual(meta.settings.relayWing, 2, 'the relay wing must be in the header');
  assert.strictEqual(meta.settings.shadowSigmaDb, 4.5, 'environment shadowing must be in the header');
  const core = loadCore();
  const rep = replayMission(text, { untilTime: s.time, core });
  assert.strictEqual(rep.time, s.time);
  assert.strictEqual(rep.delivered, s.net.delivered, 'packet outcomes must reproduce');
  assert.ok(maxPositionError(s, rep) < 1e-9, 'replay diverged by ' + maxPositionError(s, rep) + ' m');
});

test('R16: moving missions and custom (OSM-style) buildings replay exactly', () => {
  const ctx = loadCore();
  const buildings = [{ x: 150, y: 20, w: 30, d: 30, heightM: 120 }, { x: 260, y: -40, w: 24, d: 40, heightM: 90 }];
  const s = ctx.makeSwarm({
    count: 5, seed: 505, radio: R.RADIOS.find(r => r.id === 'sik-v3'), airframe: A.AIRFRAMES[1],
    envFactor: 0.45, shadowSigmaDb: 4.5, altitudeM: 60, targetX: 380, targetY: -60, captureOn: true,
    terrain: ctx.indexBuildings({ seed: 505, groundAmpM: 0, groundScaleM: 1, buildings }),
    baseVel: { x: 1.5, y: -0.5 }, targetVel: { x: -0.4, y: 0.3 },
  });
  const meta = JSON.parse(ctx.exportCaptureJSONL(s).split('\n')[0]);
  assert.strictEqual(meta.settings.terrain, 'custom', 'a generator-less map must not be recorded as flat');
  while (s.time < 30) ctx.stepSwarm(s, 0.05);
  const rep = replayMission(ctx.exportCaptureJSONL(s), { untilTime: s.time, core: loadCore() });
  assert.ok(maxPositionError(s, rep) < 1e-9, 'replay diverged by ' + maxPositionError(s, rep) + ' m');
});

test('R16: every procedural terrain is recorded by name', () => {
  const ctx = loadCore();
  for (const name of ['flat', 'rolling', 'urban', 'mixed']) {
    const s = ctx.makeSwarm({ count: 2, seed: 1, radio: R.RADIOS[0], airframe: A.AIRFRAMES[1], targetX: 900, targetY: 0,
      terrain: ctx.makeTerrain(name, { distM: 900, targetX: 900, targetY: 0, seed: 1 }) });
    const meta = JSON.parse(ctx.exportCaptureJSONL(s).split('\n')[0]);
    assert.strictEqual(meta.settings.terrain, name);
  }
});
