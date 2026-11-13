#!/usr/bin/env node
// Scenario comparison dashboard — run batch engine on two or more scenarios
// across identical seed lists and compare outcomes with statistical variance.
//
// Usage:
//   node tools/compare.js [--scenarios id1,id2] [--seeds 101,102,103] [--duration 180] [--out dashboard.md]
//
// --duration defaults to twice the longest base->objective transit at the
// mission airframe's top speed; a shorter one prints a warning.

const fs = require('node:fs');
const path = require('node:path');
const { loadCore } = require('../test/helpers/sim.js');
const { SCENARIO_PACK } = require('../js/scenarios.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const BS = require('../js/batchstats.js');
const { SIM_DT_SEC } = require('../js/swarm.js');

// What the page fills in for a field the scenario file leaves out (main.js
// resetControlsToDefaults), so a partial file runs the experiment the page
// would load from it.
const PAGE_DEFAULTS = {
  airframe: A.AIRFRAMES[1].id, count: 10, altitudeM: 50, spacingPct: 80,
  relayWing: 4, relayAirframe: 'x8', relayRadio: 'rfd900x', videoKbps: 500,
};

// Median over ALL runs with a missing value read as "not yet" (+Infinity) —
// the censored reading for time-to-arrive: a seed that never arrived is
// slower than every seed that did, not absent. Infinity when fewer than half
// the runs have a value.
function censoredMedian(vals) {
  if (!vals.length) return Infinity;
  const xs = vals.map(v => (v !== null && v !== undefined && isFinite(v) ? v : Infinity)).sort((a, b) => a - b);
  const mid = (xs.length - 1) / 2;
  return (xs[Math.floor(mid)] + xs[Math.ceil(mid)]) / 2;
}

function calcStats(vals) {
  const valid = vals.filter(v => v !== null && v !== undefined && isFinite(v));
  const total = vals.length; // count/total keeps survivorship visible (arrivals)
  const median = censoredMedian(vals);
  if (!valid.length) return { mean: 0, sd: 0, variance: 0, min: null, max: null, count: 0, total, median };
  // Sample SD (n-1) from the batch layer, so the same runs show the same ±.
  const mean = BS.mean(valid);
  const sd = BS.stdev(valid);
  const variance = sd * sd;
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return { mean, sd, variance, min, max, count: valid.length, total, median };
}

// Arrival time only exists for seeds that arrived: always say how many did,
// or a 1-of-5 success reads faster and more certain than 5-of-5 — and give
// the censored median, which ranks a 1-of-5 below a 5-of-5 on its own.
function arrivedOf(st, durationSec) {
  const med = isFinite(st.median) ? `${st.median.toFixed(1)} s` : `>${durationSec} s`;
  return `${st.count}/${st.total} arrived, median ${med}`;
}

// Mission drones cannot arrive before they have flown the distance: give the
// run at least twice the straight-line transit at the airframe's top speed.
function minDurationSec(scen) {
  const sc = scen.scenario;
  const b = posOf(sc.base, 0, 0), t = posOf(sc.target, 2000, -500);
  const af = lookup(A.AIRFRAMES, sc.airframe || PAGE_DEFAULTS.airframe, 'airframe');
  return Math.ceil(2 * Math.hypot(t.x - b.x, t.y - b.y) / af.maxSpeedMs / 10) * 10;
}

function resolveScenario(spec) {
  if (typeof spec === 'object' && spec !== null) {
    if (spec.scenario) return spec;
    return { id: spec.id || spec.name || 'custom', title: spec.name || 'Custom Scenario', scenario: spec };
  }
  if (typeof spec === 'string') {
    // Check if it's a file path
    if (fs.existsSync(spec)) {
      const parsed = JSON.parse(fs.readFileSync(spec, 'utf8'));
      return { id: path.basename(spec, '.json'), title: parsed.name || spec, scenario: parsed };
    }
    // Check SCENARIO_PACK
    const found = SCENARIO_PACK.find(p => p.id === spec || p.id === 'ddil-' + spec);
    if (found) return found;
  }
  throw new Error(`Unknown scenario: ${spec}`);
}

// A scenario file must run exactly as written or not at all: an unknown radio,
// airframe or environment silently replaced by a default is a different
// experiment, which is worse than an error.
function lookup(list, id, what) {
  const hit = list.find(x => x.id === id);
  if (!hit) throw new Error(`unknown ${what}: ${id}`);
  return hit;
}

// Saved calibrated presets travel with the scenario (radioPreset /
// relayRadioPreset); use them when the id matches, else a built-in radio.
function resolveRadio(id, preset, what) {
  if (preset && typeof preset === 'object' && preset.id === id) {
    for (const k of ['freqMHz', 'txDbm', 'sensDbm', 'airRateKbps', 'rangeLosM']) {
      if (!isFinite(preset[k])) throw new Error(`${what} preset ${id} lacks a finite ${k}`);
    }
    return { ...preset };
  }
  return lookup(R.RADIOS, id, what);
}

const posOf = (p, dx, dy) => (p ? { x: p.x, y: p.y } : { x: dx, y: dy });

// Same geometry the page builds (main.js applyScenario): the city follows the
// real base->target corridor and a density of 0 really is 0.
function buildCompareTerrain(ctx, sc, seed) {
  if (sc.terrain === 'osm') throw new Error('terrain osm needs the network; compare cannot run it offline');
  const b = posOf(sc.base, 0, 0), t = posOf(sc.target, 2000, -500);
  return ctx.makeTerrain(sc.terrain || 'flat', {
    distM: Math.hypot(t.x - b.x, t.y - b.y),
    altM: sc.altitudeM ?? PAGE_DEFAULTS.altitudeM,
    baseX: b.x, baseY: b.y, targetX: t.x, targetY: t.y,
    seed,
    density: (sc.cityDensity ?? 40) / 100,
    heightScale: (sc.cityHeight ?? 40) / 100,
  });
}

function runScenarioSeed(ctx, scenarioObj, seed, durationSec) {
  const sc = scenarioObj.scenario;
  const radio = resolveRadio(sc.radio || R.RADIOS[0].id, sc.radioPreset, 'radio');
  const env = lookup(R.ENVIRONMENTS, sc.env || R.ENVIRONMENTS[0].id, 'env');
  const airframe = lookup(A.AIRFRAMES, sc.airframe || PAGE_DEFAULTS.airframe, 'airframe');
  // A named relay airframe/radio must exist even with the wing off; a wing
  // that names none flies the page's default selections.
  const relayAirframeId = sc.relayAirframe || (sc.hetero ? PAGE_DEFAULTS.relayAirframe : null);
  const relayRadioId = sc.relayRadio || (sc.hetero ? PAGE_DEFAULTS.relayRadio : null);
  const relayAirframe = relayAirframeId ? lookup(A.AIRFRAMES, relayAirframeId, 'relay airframe') : null;
  const relayRadio = relayRadioId ? resolveRadio(relayRadioId, sc.relayRadioPreset, 'relay radio') : null;
  const terrain = buildCompareTerrain(ctx, sc, seed);
  const b = posOf(sc.base, 0, 0), t = posOf(sc.target, 2000, -500);

  const s = ctx.makeSwarm({
    count: sc.count ?? PAGE_DEFAULTS.count,
    airframe,
    altitudeM: sc.altitudeM ?? PAGE_DEFAULTS.altitudeM,
    deployFrac: (sc.spacingPct ?? PAGE_DEFAULTS.spacingPct) / 100,
    corridorRouting: sc.corridor !== false,
    broadcastC2: sc.broadcast !== false,
    windX: (sc.windSpd ?? 0) * Math.cos((sc.windDir ?? 0) * Math.PI / 180),
    windY: (sc.windSpd ?? 0) * Math.sin((sc.windDir ?? 0) * Math.PI / 180),
    baseX: b.x,
    baseY: b.y,
    targetX: t.x,
    targetY: t.y,
    baseVel: sc.baseVelMps ? { x: sc.baseVelMps.x, y: sc.baseVelMps.y } : undefined,
    targetVel: sc.targetVelMps ? { x: sc.targetVelMps.x, y: sc.targetVelMps.y } : undefined,
    adversaryMode: !!sc.adversaryMode,
    radio,
    envFactor: env.factor,
    shadowSigmaDb: env.shadowSigmaDb,
    seed,
    terrain,
    relayWing: sc.hetero ? (sc.relayWing ?? PAGE_DEFAULTS.relayWing) : 0,
    relayAirframe,
    relayRadio,
    jammers: sc.jammers || [],
    gpsZones: sc.gpsZones || [],
    spectrumAgility: !!sc.spectrumAgility,
    lpiMode: !!sc.lpiMode,
    videoOn: !!(sc.videoBackhaul ?? sc.videoOn), // the page reads videoOn when videoBackhaul is absent
    videoKbps: sc.videoKbps ?? PAGE_DEFAULTS.videoKbps,
  });

  // Energy is integrated per step: a completed battery swap resets energyWh to
  // full, so start-minus-final would forget everything burned before it.
  let totalWhConsumed = 0;
  let firstArrivalTime = null;
  const targetDistThreshold = 200; // metres from target

  while (s.time < durationSec) {
    const beforeWh = new Map(s.drones.map(d => [d.id, d.energyWh]));
    ctx.stepSwarm(s, SIM_DT_SEC);
    for (const d of s.drones) {
      const before = beforeWh.get(d.id);
      if (before != null) totalWhConsumed += Math.max(0, before - d.energyWh);
    }

    if (firstArrivalTime === null) {
      for (const d of s.drones) {
        if (ctx.alive(d) && d.order && d.order.role === 'mission') {
          const dist = Math.hypot(d.x - s.target.x, d.y - s.target.y);
          if (dist <= targetDistThreshold) {
            firstArrivalTime = s.time;
            break;
          }
        }
      }
    }
  }

  const meanWhConsumed = totalWhConsumed / Math.max(1, s.drones.length);

  // Uptime is the consumer metric (swarm.js finding #6): a live route from C2
  // to a mission drone ON STATION at the objective. Reaching the flock
  // anywhere en route is fleet contact, reported beside it, never instead.
  const uptimePct = 100 * (s.stats.connSec || 0) / Math.max(1e-9, s.stats.tSec);
  const fleetUptimePct = 100 * (s.stats.fleetConnSec || 0) / Math.max(1e-9, s.stats.tSec);
  // Control-plane loss (telemetry, orders, broadcast reach; no video
  // fragments): scenarios that toggle broadcast stay comparable (NET-04).
  const droppedPct = ctx.controlLossPct(s);

  return {
    seed,
    uptimePct,
    fleetUptimePct,
    arrivalTime: firstArrivalTime,
    droppedPct,
    meanWhConsumed,
    delivered: s.net.delivered,
    dropped: s.net.dropped,
  };
}

function compareScenarios(scenarioSpecs, options = {}) {
  const ctx = loadCore(['scenarios.js']);
  const seeds = options.seeds || [101, 102, 103, 104, 105];
  // A repeated seed is a bit-identical copy, not a sample: it would shrink
  // every reported ± toward zero (batch.js refuses them the same way).
  if (new Set(seeds).size !== seeds.length) throw new Error('seeds must be distinct: ' + seeds.join(','));
  const scenarios = scenarioSpecs.map(resolveScenario);
  // No duration given: long enough for every scenario's transit, so the
  // arrival column is not N/A by construction. A shorter explicit one warns.
  const needSec = Math.max(120, ...scenarios.map(minDurationSec));
  const durationSec = options.durationSec || needSec;
  const warnings = durationSec < needSec
    ? [`duration ${durationSec} s is under twice the longest transit (${needSec} s): most seeds cannot arrive in time`]
    : [];

  const results = [];

  for (const scen of scenarios) {
    const seedRuns = [];
    for (const seed of seeds) {
      const run = runScenarioSeed(ctx, scen, seed, durationSec);
      seedRuns.push(run);
    }

    const uptimes = seedRuns.map(r => r.uptimePct);
    const fleetUptimes = seedRuns.map(r => r.fleetUptimePct);
    const arrivals = seedRuns.map(r => r.arrivalTime);
    const dropPcts = seedRuns.map(r => r.droppedPct);
    const energies = seedRuns.map(r => r.meanWhConsumed);

    results.push({
      id: scen.id,
      title: scen.title,
      seedsCount: seeds.length,
      runs: seedRuns,
      uptime: calcStats(uptimes),
      fleetUptime: calcStats(fleetUptimes),
      arrival: calcStats(arrivals),
      droppedPct: calcStats(dropPcts),
      energyWh: calcStats(energies),
    });
  }

  return {
    seeds,
    durationSec,
    warnings,
    results,
    markdown: renderMarkdownDashboard(results, seeds, durationSec),
    text: renderTextDashboard(results, seeds, durationSec),
  };
}

// Rows built before fleet contact had its own column render it as '—'.
const pctCell = (st, sep) => (st ? `${st.mean.toFixed(1)}% (±${st.sd.toFixed(1)}${sep})` : '—');

function renderMarkdownDashboard(results, seeds, durationSec) {
  const rows = results.map(r => {
    const arrivalStr = r.arrival.count > 0
      ? `${r.arrival.mean.toFixed(1)} s (±${r.arrival.sd.toFixed(1)}), ${arrivedOf(r.arrival, durationSec)}`
      : `N/A (${arrivedOf(r.arrival, durationSec)})`;
    return `| **${r.title}** | ${r.uptime.mean.toFixed(1)}% (±${r.uptime.sd.toFixed(1)}%) | ${pctCell(r.fleetUptime, '%')} | ${arrivalStr} | ${r.droppedPct.mean.toFixed(1)}% (±${r.droppedPct.sd.toFixed(1)}%) | ${r.energyWh.mean.toFixed(2)} Wh (±${r.energyWh.sd.toFixed(2)}) |`;
  });

  return [
    '# Scenario Comparison Dashboard',
    '',
    `Evaluation over **${results.length} scenarios** across **${seeds.length} identical seeds** (\`${seeds.join(', ')}\`) for **${durationSec}s** each.`,
    '',
    '| Scenario | Objective uptime (Mean ± SD) | Fleet contact (Mean ± SD) | Arrival Time (Mean ± SD) | Packet Loss (Mean ± SD) | Energy Consumed (Mean ± SD) |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '### Metric Definitions',
    '- **Objective uptime**: % of mission time C2 has a live route to a mission drone on station at the objective (the uptime the app, batch reports and after-action report show).',
    '- **Fleet contact**: % of mission time C2 has a live route to any mission drone anywhere, en route included; not objective coverage.',
    '- **Arrival Time**: Seconds from takeoff until the first tactical drone arrives within objective perimeter (200m). The mean ± SD covers only the seeds that arrived; k/N says how many did, and the median counts a seed that never arrived as slower than every one that did (">duration" when fewer than half arrived).',
    '- **Packet Loss**: Control-plane loss: telemetry, acks and orders dropped on a link or for want of a route, plus addressed drones that missed a broadcast order round, as a percentage of all of them. Video fragments are not counted.',
    '- **Energy Consumed**: Mean per-drone battery consumption in Watt-hours over the mission.',
    '- **Variance (SD)**: Standard deviation across the identical seed Monte Carlo iterations.',
    '',
  ].join('\n');
}

function renderTextDashboard(results, seeds, durationSec) {
  const lines = [
    `\n=== Scenario Comparison Dashboard (${results.length} scenarios, ${seeds.length} seeds, ${durationSec}s each) ===\n`,
    `${'Scenario'.padEnd(32)} ${'Obj uptime'.padEnd(16)} ${'Fleet contact'.padEnd(16)} ${'Arrival'.padEnd(18)} ${'Loss'.padEnd(16)} ${'Energy/Dr'.padEnd(16)}`,
    '-'.repeat(115),
  ];

  for (const r of results) {
    const name = r.title.length > 30 ? r.title.slice(0, 27) + '…' : r.title;
    const uptime = `${r.uptime.mean.toFixed(1)}% (±${r.uptime.sd.toFixed(1)})`;
    const fleet = pctCell(r.fleetUptime, '');
    const med = isFinite(r.arrival.median) ? `${r.arrival.median.toFixed(1)}s` : `>${durationSec}s`;
    const arrived = `${r.arrival.count}/${r.arrival.total} med ${med}`;
    const arrival = r.arrival.count > 0 ? `${r.arrival.mean.toFixed(1)}s (±${r.arrival.sd.toFixed(1)}) ${arrived}` : `N/A ${arrived}`;
    const loss = `${r.droppedPct.mean.toFixed(1)}% (±${r.droppedPct.sd.toFixed(1)})`;
    const energy = `${r.energyWh.mean.toFixed(1)}Wh (±${r.energyWh.sd.toFixed(1)})`;
    lines.push(`${name.padEnd(32)} ${uptime.padEnd(16)} ${fleet.padEnd(16)} ${arrival.padEnd(18)} ${loss.padEnd(16)} ${energy.padEnd(16)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    scenarios: ['ddil-disrupted', 'ddil-full'],
    seeds: [101, 102, 103, 104, 105],
    durationSec: null, // compareScenarios sizes it from the missions' transit
    out: null,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scenarios' && args[i + 1]) {
      options.scenarios = args[++i].split(',').map(s => s.trim());
    } else if (args[i] === '--seeds' && args[i + 1]) {
      options.seeds = args[++i].split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    } else if (args[i] === '--duration' && args[i + 1]) {
      options.durationSec = parseFloat(args[++i]);
    } else if (args[i] === '--out' && args[i + 1]) {
      options.out = args[++i];
    }
  }
  return options;
}

function main() {
  const options = parseArgs();
  console.log(`Running scenario comparison: [${options.scenarios.join(', ')}] with ${options.seeds.length} seeds…`);
  const comparison = compareScenarios(options.scenarios, options);
  for (const w of comparison.warnings) console.warn('warning: ' + w);

  console.log(comparison.text);

  if (options.out) {
    fs.writeFileSync(options.out, comparison.markdown);
    console.log(`Saved dashboard markdown to ${options.out}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  calcStats,
  censoredMedian,
  minDurationSec,
  resolveScenario,
  runScenarioSeed,
  buildCompareTerrain,
  compareScenarios,
  renderMarkdownDashboard,
  renderTextDashboard,
};
