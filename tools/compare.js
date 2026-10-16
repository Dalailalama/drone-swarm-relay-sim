#!/usr/bin/env node
// Scenario comparison dashboard — run batch engine on two or more scenarios
// across identical seed lists and compare outcomes with statistical variance.
//
// Usage:
//   node tools/compare.js [--scenarios id1,id2] [--seeds 101,102,103] [--duration 180] [--out dashboard.md]

const fs = require('node:fs');
const path = require('node:path');
const { loadCore } = require('../test/helpers/sim.js');
const { SCENARIO_PACK } = require('../js/scenarios.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { SIM_DT_SEC } = require('../js/swarm.js');

function calcStats(vals) {
  const valid = vals.filter(v => v !== null && v !== undefined && isFinite(v));
  if (!valid.length) return { mean: 0, sd: 0, variance: 0, min: null, max: null, count: 0 };
  const mean = valid.reduce((sum, v) => sum + v, 0) / valid.length;
  const variance = valid.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / valid.length;
  const sd = Math.sqrt(variance);
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return { mean, sd, variance, min, max, count: valid.length };
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
    altM: sc.altitudeM ?? 70,
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
  const airframe = lookup(A.AIRFRAMES, sc.airframe || A.AIRFRAMES[0].id, 'airframe');
  const relayAirframe = sc.relayAirframe ? lookup(A.AIRFRAMES, sc.relayAirframe, 'relay airframe') : null;
  const relayRadio = sc.relayRadio ? resolveRadio(sc.relayRadio, sc.relayRadioPreset, 'relay radio') : null;
  const terrain = buildCompareTerrain(ctx, sc, seed);
  const b = posOf(sc.base, 0, 0), t = posOf(sc.target, 2000, -500);

  const s = ctx.makeSwarm({
    count: sc.count ?? 8,
    airframe,
    altitudeM: sc.altitudeM ?? 70,
    deployFrac: (sc.spacingPct ?? 80) / 100,
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
    relayWing: sc.hetero ? (sc.relayWing ?? 0) : 0,
    relayAirframe,
    relayRadio,
    jammers: sc.jammers || [],
    gpsZones: sc.gpsZones || [],
    spectrumAgility: !!sc.spectrumAgility,
    lpiMode: !!sc.lpiMode,
    videoOn: !!sc.videoBackhaul,
    videoKbps: sc.videoKbps ?? 250,
  });

  // Calculate starting energy Wh
  const startWhMap = new Map(s.drones.map(d => [d.id, d.energyWh]));
  let firstArrivalTime = null;
  const targetDistThreshold = 200; // metres from target

  while (s.time < durationSec) {
    ctx.stepSwarm(s, SIM_DT_SEC);

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

  // Energy consumed across all drones
  let totalWhConsumed = 0;
  for (const d of s.drones) {
    const init = startWhMap.get(d.id) || d.energyWh;
    totalWhConsumed += Math.max(0, init - d.energyWh);
  }
  const meanWhConsumed = totalWhConsumed / Math.max(1, s.drones.length);

  const connSec = s.stats.fleetConnSec || s.stats.connSec || 0;
  const uptimePct = 100 * connSec / Math.max(1e-9, s.stats.tSec);
  const totalPkts = s.net.delivered + s.net.dropped;
  const droppedPct = 100 * s.net.dropped / Math.max(1, totalPkts);

  return {
    seed,
    uptimePct,
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
  const durationSec = options.durationSec || 120;
  const scenarios = scenarioSpecs.map(resolveScenario);

  const results = [];

  for (const scen of scenarios) {
    const seedRuns = [];
    for (const seed of seeds) {
      const run = runScenarioSeed(ctx, scen, seed, durationSec);
      seedRuns.push(run);
    }

    const uptimes = seedRuns.map(r => r.uptimePct);
    const arrivals = seedRuns.map(r => r.arrivalTime);
    const dropPcts = seedRuns.map(r => r.droppedPct);
    const energies = seedRuns.map(r => r.meanWhConsumed);

    results.push({
      id: scen.id,
      title: scen.title,
      seedsCount: seeds.length,
      runs: seedRuns,
      uptime: calcStats(uptimes),
      arrival: calcStats(arrivals),
      droppedPct: calcStats(dropPcts),
      energyWh: calcStats(energies),
    });
  }

  return {
    seeds,
    durationSec,
    results,
    markdown: renderMarkdownDashboard(results, seeds, durationSec),
    text: renderTextDashboard(results, seeds, durationSec),
  };
}

function renderMarkdownDashboard(results, seeds, durationSec) {
  const rows = results.map(r => {
    const arrivalStr = r.arrival.count > 0
      ? `${r.arrival.mean.toFixed(1)} s (±${r.arrival.sd.toFixed(1)})`
      : 'N/A (unreached)';
    return `| **${r.title}** | ${r.uptime.mean.toFixed(1)}% (±${r.uptime.sd.toFixed(1)}%) | ${arrivalStr} | ${r.droppedPct.mean.toFixed(1)}% (±${r.droppedPct.sd.toFixed(1)}%) | ${r.energyWh.mean.toFixed(2)} Wh (±${r.energyWh.sd.toFixed(2)}) |`;
  });

  return [
    '# Scenario Comparison Dashboard',
    '',
    `Evaluation over **${results.length} scenarios** across **${seeds.length} identical seeds** (\`${seeds.join(', ')}\`) for **${durationSec}s** each.`,
    '',
    '| Scenario | Uptime (Mean ± SD) | Arrival Time (Mean ± SD) | Packet Loss (Mean ± SD) | Energy Consumed (Mean ± SD) |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '### Metric Definitions',
    '- **Uptime**: % of mission time fleet maintains active C2 connectivity to ground station.',
    '- **Arrival Time**: Seconds from takeoff until the first tactical drone arrives within objective perimeter (200m).',
    '- **Packet Loss**: Total link and routing drops as a percentage of total transmitted packets.',
    '- **Energy Consumed**: Mean per-drone battery consumption in Watt-hours over the mission.',
    '- **Variance (SD)**: Standard deviation across the identical seed Monte Carlo iterations.',
    '',
  ].join('\n');
}

function renderTextDashboard(results, seeds, durationSec) {
  const lines = [
    `\n=== Scenario Comparison Dashboard (${results.length} scenarios, ${seeds.length} seeds, ${durationSec}s each) ===\n`,
    `${'Scenario'.padEnd(32)} ${'Uptime'.padEnd(16)} ${'Arrival'.padEnd(18)} ${'Loss'.padEnd(16)} ${'Energy/Dr'.padEnd(16)}`,
    '-'.repeat(98),
  ];

  for (const r of results) {
    const name = r.title.length > 30 ? r.title.slice(0, 27) + '…' : r.title;
    const uptime = `${r.uptime.mean.toFixed(1)}% (±${r.uptime.sd.toFixed(1)})`;
    const arrival = r.arrival.count > 0 ? `${r.arrival.mean.toFixed(1)}s (±${r.arrival.sd.toFixed(1)})` : 'N/A';
    const loss = `${r.droppedPct.mean.toFixed(1)}% (±${r.droppedPct.sd.toFixed(1)})`;
    const energy = `${r.energyWh.mean.toFixed(1)}Wh (±${r.energyWh.sd.toFixed(1)})`;
    lines.push(`${name.padEnd(32)} ${uptime.padEnd(16)} ${arrival.padEnd(18)} ${loss.padEnd(16)} ${energy.padEnd(16)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    scenarios: ['ddil-disrupted', 'ddil-full'],
    seeds: [101, 102, 103, 104, 105],
    durationSec: 120,
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
  resolveScenario,
  runScenarioSeed,
  buildCompareTerrain,
  compareScenarios,
  renderMarkdownDashboard,
  renderTextDashboard,
};
