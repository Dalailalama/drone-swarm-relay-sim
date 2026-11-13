const { test } = require('node:test');
const assert = require('node:assert');
const { compareScenarios, resolveScenario } = require('../tools/compare.js');

test('Item 10: resolveScenario resolves known DDIL pack scenarios and custom objects', () => {
  const s1 = resolveScenario('ddil-disrupted');
  assert.strictEqual(s1.id, 'ddil-disrupted');
  assert.ok(s1.scenario.radio);

  const custom = { id: 'custom-1', name: 'Custom Test', radio: 'rfd900x', count: 4, target: { x: 1000, y: 0 } };
  const s2 = resolveScenario(custom);
  assert.strictEqual(s2.id, 'custom-1');
  assert.strictEqual(s2.scenario.radio, 'rfd900x');
});

test('Item 10: compareScenarios computes uptime, arrival, packet loss, energy and variance across identical seeds', () => {
  const result = compareScenarios(['ddil-disrupted', 'ddil-denied'], {
    seeds: [101, 102],
    durationSec: 15,
  });

  assert.strictEqual(result.seeds.length, 2);
  assert.strictEqual(result.results.length, 2);

  for (const r of result.results) {
    assert.ok(typeof r.uptime.mean === 'number');
    assert.ok(typeof r.uptime.sd === 'number');
    assert.ok(typeof r.droppedPct.mean === 'number');
    assert.ok(typeof r.energyWh.mean === 'number');
    assert.strictEqual(r.runs.length, 2);
  }

  assert.ok(result.markdown.includes('Scenario Comparison Dashboard'));
  assert.ok(result.markdown.includes('ddil-disrupted') || result.markdown.includes('Disrupted'));
  assert.ok(result.text.includes('Scenario Comparison Dashboard'));
});

// audit: compare must run the scenario file exactly or refuse.
const { runScenarioSeed, buildCompareTerrain } = require('../tools/compare.js');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');

test('compare refuses unknown radio, airframe, env and the network-only osm terrain', () => {
  const ctx = loadCore(['scenarios.js']);
  const base = resolveScenario('ddil-disrupted').scenario;
  for (const patch of [{ radio: 'nope' }, { airframe: 'nope' }, { env: 'nope' }, { terrain: 'osm' }, { relayRadio: 'nope' }]) {
    const sc = { ...base, ...patch };
    assert.throws(() => runScenarioSeed(ctx, { id: 'x', title: 'x', scenario: sc }, 101, 1), /unknown|osm/i, JSON.stringify(patch));
  }
});

test('compare honours a calibrated radioPreset instead of falling back to the stock radio', () => {
  const ctx = loadCore(['scenarios.js']);
  const base = resolveScenario('ddil-disrupted').scenario;
  const stock = R.RADIOS.find(r => r.id === base.radio);
  const preset = { ...stock, id: base.radio + '-calibrated', rangeLosM: stock.rangeLosM / 5, txDbm: stock.txDbm - 25 };
  const a = runScenarioSeed(ctx, { id: 'a', title: 'a', scenario: base }, 101, 40);
  const b = runScenarioSeed(ctx, { id: 'b', title: 'b', scenario: { ...base, radio: preset.id, radioPreset: preset } }, 101, 40);
  assert.notDeepStrictEqual([a.delivered, a.dropped, a.uptimePct], [b.delivered, b.dropped, b.uptimePct]);
});

test('compare lays the city along the real base->target corridor and honours cityDensity 0', () => {
  const ctx = loadCore(['scenarios.js']);
  const sc = resolveScenario('ddil-intermittent').scenario;
  const page = density => ctx.makeTerrain(sc.terrain, {
    distM: Math.hypot(sc.target.x - sc.base.x, sc.target.y - sc.base.y), altM: sc.altitudeM,
    baseX: sc.base.x, baseY: sc.base.y, targetX: sc.target.x, targetY: sc.target.y, seed: 101,
    density, heightScale: (sc.cityHeight ?? 40) / 100,
  });
  const t = buildCompareTerrain(ctx, sc, 101);
  assert.deepStrictEqual(t.gen, page((sc.cityDensity ?? 40) / 100).gen);
  assert.strictEqual(t.buildings.length, page((sc.cityDensity ?? 40) / 100).buildings.length);
  assert.strictEqual(buildCompareTerrain(ctx, { ...sc, cityDensity: 0 }, 101).buildings.length, page(0).buildings.length);
});

test('compare energy keeps what was burned before a battery swap reset the pack to full', () => {
  const ctx = loadCore(['scenarios.js']);
  const sc = resolveScenario('ddil-disrupted').scenario;
  // Wrap the real step: at t=5 s every pack is swapped back to full, the way a
  // completed swap does in swarm.js. Burn before the swap must still count.
  let full = null, burnedBeforeSwap = 0, swapped = false;
  const wrapped = Object.create(ctx);
  wrapped.stepSwarm = (s, dt) => {
    if (!full) full = new Map(s.drones.map(d => [d.id, d.energyWh]));
    ctx.stepSwarm(s, dt);
    if (!swapped && s.time >= 5) {
      swapped = true;
      for (const d of s.drones) { burnedBeforeSwap += full.get(d.id) - d.energyWh; d.energyWh = full.get(d.id); }
    }
  };
  const r = runScenarioSeed(wrapped, { id: 'e', title: 'e', scenario: sc }, 101, 6);
  assert.ok(swapped);
  assert.ok(r.meanWhConsumed >= 0.99 * burnedBeforeSwap / sc.count, `${r.meanWhConsumed} vs ${burnedBeforeSwap / sc.count}`);
});

test('compare arrival statistics say how many seeds arrived, so 1-of-5 cannot read as faster than 5-of-5', () => {
  const { calcStats, renderMarkdownDashboard, renderTextDashboard } = require('../tools/compare.js');
  const row = (title, arr) => ({ title, uptime: calcStats([50, 50]), arrival: calcStats(arr), droppedPct: calcStats([1, 1]), energyWh: calcStats([2, 2]) });
  const results = [row('A', [148, 150, 152, 149, 151]), row('B', [100, null, null, null, null])];
  const md = renderMarkdownDashboard(results, [1, 2, 3, 4, 5], 300);
  const txt = renderTextDashboard(results, [1, 2, 3, 4, 5], 300);
  for (const out of [md, txt]) {
    assert.ok(out.includes('1/5'), out);
    assert.ok(out.includes('5/5'), out);
  }
  // The censored median ranks 1-of-5 behind 5-of-5 without reading the k/N.
  assert.ok(md.includes('median 150.0 s') && md.includes('median >300 s'), md);
  assert.ok(txt.includes('med 150.0s') && txt.includes('med >300s'), txt);
});

test('compare sizes its default duration from the missions, so the CLI defaults can arrive; a short one warns', () => {
  const { minDurationSec, censoredMedian } = require('../tools/compare.js');
  const A = require('../js/airframes.js');
  for (const id of ['ddil-disrupted', 'ddil-full']) {
    const sc = resolveScenario(id).scenario;
    const transitSec = Math.hypot(sc.target.x - sc.base.x, sc.target.y - sc.base.y) / A.AIRFRAMES.find(a => a.id === sc.airframe).maxSpeedMs;
    assert.ok(minDurationSec(resolveScenario(id)) >= 2 * transitSec, id);
  }
  // No seeds: nothing runs, only the duration is resolved.
  const dflt = compareScenarios(['ddil-disrupted', 'ddil-full'], { seeds: [] });
  assert.ok(dflt.durationSec >= minDurationSec(resolveScenario('ddil-full')), String(dflt.durationSec));
  assert.deepStrictEqual(dflt.warnings, []);
  const short = compareScenarios(['ddil-limited'], { seeds: [101], durationSec: 15 });
  assert.match(short.warnings.join(' '), /transit/);
  assert.strictEqual(censoredMedian([3, null, 1]), 3);
  assert.strictEqual(censoredMedian([3, null, null]), Infinity);
});

// audit swarm-onboard/TOOL-01: 'Uptime' read fleetConnSec (C2 reaches a
// mission drone anywhere), so a scenario with 0% objective uptime showed 76%.
test('compare Uptime is the objective-connected metric; fleet contact is its own column', () => {
  const ctx = loadCore(['scenarios.js']);
  const sc = resolveScenario('ddil-limited').scenario;
  let S = null;
  const wrapped = Object.create(ctx);
  wrapped.stepSwarm = (s, dt) => { S = s; return ctx.stepSwarm(s, dt); };
  const r = runScenarioSeed(wrapped, { id: 'u', title: 'u', scenario: sc }, sc.seed, 20);
  // 20 s into a 3.7 km transit: C2 reaches the flock, nobody is on station.
  assert.ok(S.stats.fleetConnSec > 0 && S.stats.connSec === 0, JSON.stringify(S.stats));
  assert.strictEqual(r.uptimePct, 100 * S.stats.connSec / S.stats.tSec);
  assert.strictEqual(r.fleetUptimePct, 100 * S.stats.fleetConnSec / S.stats.tSec);
  const { calcStats, renderMarkdownDashboard, renderTextDashboard } = require('../tools/compare.js');
  const row = { title: 'A', uptime: calcStats([0, 0]), fleetUptime: calcStats([90, 92]), arrival: calcStats([null, null]),
    droppedPct: calcStats([1, 1]), energyWh: calcStats([2, 2]) };
  const md = renderMarkdownDashboard([row], [1, 2], 40);
  assert.ok(md.includes('Objective uptime') && md.includes('Fleet contact') && md.includes('91.0%'), md);
  assert.ok(renderTextDashboard([row], [1, 2], 40).includes('91.0%'));
});
