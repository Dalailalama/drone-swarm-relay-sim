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
  for (let i = 0; i < 100 && el('replayBtn').disabled; i++) ctx.__timers.run(); // the replay runs in slices
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

// Audit C-replay: every mid-run UI action that changes the sim must be in
// the capture and replay at its sim time. Only kill and drag-release were
// recorded, and only while capture was on, so adding interference, a GPS
// outage, wind, a new objective, a toggle or a city edit mid-run (or acting
// before capture was switched on) made the replay silently diverge.
const MIDRUN_SCENARIO = {
  version: 1, radio: 'sik-v3', env: 'suburban', airframe: 'q450', count: 6, altitudeM: 60, spacingPct: 80,
  terrain: 'urban', cityDensity: 40, cityHeight: 45, seed: 77,
  base: { x: 0, y: 0 }, target: { x: 420, y: -160 }, windSpd: 3, windDir: 40,
  jammers: [{ x: 210, y: -60, erpDbm: 18, band: 'all', altM: 15, on: true }],
  gpsZones: [{ x: 300, y: -120, rM: 120, on: true }],
};

function setVal(ui, id, v, evName) { ui.el(id).value = String(v); ui.fire(id, evName || 'input'); }
function flip(ui, id) { ui.el(id).checked = !ui.el(id).checked; ui.fire(id, 'change'); }
function killSecondDrone(ui) {
  const d = ui.ctx.sim.swarm.drones[1];
  const row = ui.el('fleetBody').querySelector('[data-id="' + d.id + '"]');
  ui.el('fleetBody').fire('click', { target: row });
  ui.ctx.__raf.pump(200);
  ui.el('killBtn').click();
  assert.strictEqual(d.mode, 'dead', 'the UI kill must land');
}

const MIDRUN_ACTIONS = {
  'add interference source': ui => ui.el('addJammerBtn').click(),
  'jammer power, toggle and remove': ui => {
    ui.el('addJammerBtn').click();
    setVal(ui, 'jammerPowerRange', 30);
    ui.ctx.__raf.pump(200);
    ui.el('jammerToggleBtn').click();
    ui.ctx.__raf.pump(200);
    ui.el('jammerToggleBtn').click();
    ui.ctx.__raf.pump(200);
    ui.el('jammerRemoveBtn').click();
  },
  'clear interference': ui => ui.el('clearJammersBtn').click(),
  'add GPS outage, toggle, remove': ui => {
    ui.el('addGpsZoneBtn').click();
    ui.ctx.__raf.pump(200);
    ui.el('zoneToggleBtn').click();
    ui.ctx.__raf.pump(200);
    ui.el('zoneRemoveBtn').click();
    ui.ctx.__raf.pump(200);
    ui.el('addGpsZoneBtn').click();
  },
  'wind 12 m/s': ui => setVal(ui, 'windSpdRange', 12),
  'target distance slider': ui => setVal(ui, 'distRange', 160),
  'altitude slider': ui => setVal(ui, 'altRange', 120),
  'spacing slider': ui => setVal(ui, 'spacingRange', 100),
  'environment urban': ui => setVal(ui, 'envSel', 'urban', 'change'),
  'broadcast C2 off': ui => flip(ui, 'bcastChk'),
  'corridor routing off': ui => flip(ui, 'corridorChk'),
  'spectrum agility + LPI': ui => { flip(ui, 'agilityChk'); flip(ui, 'lpiChk'); },
  'video backhaul on': ui => flip(ui, 'videoChk'),
  'red team on': ui => flip(ui, 'advChk'),
  'city density': ui => { setVal(ui, 'cityDensityRange', 90); ui.ctx.__timers.run(); },
  'TAK objective': ui => {
    ui.ctx.sim.swarm.takMarks = [{ id: 'm1', callsign: 'OBJ', lat: 0, lon: 0, x: 600, y: 140 }];
    const btn = { dataset: { i: '0' } };
    btn.closest = () => btn;
    ui.el('takList').fire('click', { target: btn });
  },
  'kill': killSecondDrone,
};

function runMidrun(action, opts) {
  const o = opts || {};
  const ui = loadUI();
  const { ctx, el, fire } = ui;
  el('loadScenarioInput').files = [makeFile('ui.json', JSON.stringify(MIDRUN_SCENARIO))];
  fire('loadScenarioInput', 'change');
  assert.deepStrictEqual(ctx.__alerts, []);
  if (!o.lateCapture) el('captureChk').click();
  for (let i = 0; i < 25; i++) ctx.__raf.pump(200);
  action(ui);
  for (let i = 0; i < 10; i++) ctx.__raf.pump(200);
  if (o.lateCapture) el('captureChk').click();
  for (let i = 0; i < 15; i++) ctx.__raf.pump(200);
  const s = ctx.sim.swarm;
  el('exportBtn').click();
  const text = ctx.__downloads[ctx.__downloads.length - 1].text;
  const rep = replayMission(text, { untilTime: s.time, core: loadCore() });
  return { s, rep, text };
}

function assertReplayMatches(s, rep) {
  // Spread first: arrays from the page's vm realm fail deepStrictEqual.
  const sig = a => [...(a || [])].map(x => [x.id, x.on, x.erpDbm, x.x, x.y].join(':')).sort().join(' ');
  assert.strictEqual(sig(rep.swarm.jammers), sig(s.jammers), 'jammer set diverged');
  assert.strictEqual(sig(rep.swarm.gpsZones), sig(s.gpsZones), 'GPS zone set diverged');
  const dead = sw => [...sw.drones].filter(d => d.mode === 'dead').map(d => d.id).join(' ');
  assert.strictEqual(dead(rep.swarm), dead(s), 'dead set diverged');
  assert.strictEqual(rep.delivered, s.net.delivered, 'packet outcomes must reproduce');
  assert.ok(maxPositionError(s, rep) < 1e-9, 'replay diverged by ' + maxPositionError(s, rep) + ' m');
}

for (const [name, action] of Object.entries(MIDRUN_ACTIONS)) {
  test('C-replay: a mid-run "' + name + '" replays exactly', () => {
    const { s, rep } = runMidrun(action);
    assertReplayMatches(s, rep);
  });
}

test('C-replay: an action taken before capture is switched on still replays', () => {
  const { s, rep, text } = runMidrun(ui => { killSecondDrone(ui); ui.el('addJammerBtn').click(); }, { lateCapture: true });
  const meta = JSON.parse(text.split('\n')[0]);
  assert.ok(meta.captureStartT > 0, 'the header must say when packet capture began');
  assertReplayMatches(s, rep);
});
