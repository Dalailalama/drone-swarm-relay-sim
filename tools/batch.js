#!/usr/bin/env node
// Batch Monte Carlo engine — "run 500 seeded missions overnight, wake up to
// a confidence report."
//
//   node tools/batch.js --config batch/example.json --out out/
//
// Or import it: runBatch(config) -> {rows, summary, md, csv} — the REST API
// (tools/server.js) is a thin HTTP wrapper around exactly this function.
//
// A config sweeps one or more CELLS (named parameter variations) across many
// seeds. Every run goes through the same headless vm harness the test-suite
// uses — the browser code paths verbatim, determinism included.

const fs = require('node:fs');
const path = require('node:path');
const { loadCore } = require('../test/helpers/sim.js');
const stats = require('../js/batchstats.js');

const R = require('../js/radios.js');
const A = require('../js/airframes.js');
// The browser's exact timestep — equal seeds must replay identically here
// (finding #28), or batch results describe a different simulator.
const { SIM_DT_SEC } = require('../js/swarm.js');

// Guardrails so a stray config can't wedge the server for an hour.
// The work budget is measured in DRONE-SECONDS of simulation (runs × sim
// duration × fleet size) — the quantity that actually predicts compute.
// The old runs×duration cap was redundant with the run/duration caps and
// let a max-fleet sweep through at 12× the intended budget (finding #30).
const LIMITS = {
  maxCells: 40,
  maxSeedsPerCell: 20,
  maxTotalRuns: 200,
  maxDurationSec: 1800,
  maxDrones: 120,
  maxCoordM: 100000,
  maxTotalWorkDroneSec: 600000, // ~10 min of wall clock at the measured ~1 ms per drone-sim-second
};

function normalizeConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const cells = Array.isArray(cfg.sweep) && cfg.sweep.length ? cfg.sweep : [{ name: 'base' }];
  const seeds = Array.isArray(cfg.seeds) && cfg.seeds.length ? cfg.seeds : [101, 102, 103];
  const durationSec = Math.min(LIMITS.maxDurationSec, Math.max(30, cfg.durationSec != null ? cfg.durationSec : 300));
  const count = Math.min(LIMITS.maxDrones, Math.max(1, cfg.count != null ? cfg.count : 10));
  return {
    ...cfg,
    count,
    durationSec,
    seeds,
    sweep: cells,
    airframe: cfg.airframe || 'q450',
    terrain: cfg.terrain || 'flat',
  };
}

// Strict on purpose (finding #30): a field the caller PROVIDED must be
// valid — treating a wrong type as "omitted" silently runs a different
// experiment than the one requested, which is worse than an error.
function finiteNum(v) { return typeof v === 'number' && isFinite(v); }
function numIn(v, lo, hi) { return finiteNum(v) && v >= lo && v <= hi; }

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'config must be a JSON object';
  if (!R.RADIOS.some(r => r.id === cfg.radio)) return 'unknown radio: ' + cfg.radio;
  // hasOwnProperty guard: inherited keys like 'toString' are truthy lookups
  // on a plain object literal and used to sail through as an "env".
  const ENVS = ['open', 'suburban', 'urban'];
  if (typeof cfg.env !== 'string' || ENVS.indexOf(cfg.env) < 0) return 'env must be open|suburban|urban';
  if (cfg.airframe != null && !A.AIRFRAMES.some(a => a.id === cfg.airframe)) return 'unknown airframe';
  if (cfg.terrain != null && ['flat', 'rolling', 'urban', 'mixed'].indexOf(cfg.terrain) < 0) return 'unknown terrain';

  if (cfg.sweep != null && !Array.isArray(cfg.sweep)) return 'sweep must be an array of cells';
  const cells = Array.isArray(cfg.sweep) ? cfg.sweep : [{ name: 'base' }];
  if (!cells.length || cells.length > LIMITS.maxCells) return 'sweep must have 1..' + LIMITS.maxCells + ' cells';
  const names = new Set();
  for (const c of cells) {
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !c.name || c.name.length > 40) {
      return 'every sweep cell needs a name (string, <=40 chars)';
    }
    if (names.has(c.name)) return 'duplicate sweep cell name: ' + c.name;
    names.add(c.name);
    if (c.altitudeM != null && !numIn(c.altitudeM, 5, 1000)) return 'cell "' + c.name + '": altitudeM must be 5..1000';
    if (c.spacingPct != null && !numIn(c.spacingPct, 30, 150)) return 'cell "' + c.name + '": spacingPct must be 30..150';
  }

  if (cfg.seeds != null && !Array.isArray(cfg.seeds)) return 'seeds must be an array of integers';
  const seeds = Array.isArray(cfg.seeds) ? cfg.seeds : [101, 102, 103];
  if (!seeds.length || seeds.length > LIMITS.maxSeedsPerCell) {
    return 'seeds must be a non-empty array of at most ' + LIMITS.maxSeedsPerCell;
  }
  for (const s of seeds) {
    if (!finiteNum(s) || !Number.isInteger(s)) return 'seeds must be integers';
  }

  const totalRuns = cells.length * seeds.length;
  if (totalRuns > LIMITS.maxTotalRuns) {
    return 'total runs (' + totalRuns + ') exceeds cap ' + LIMITS.maxTotalRuns;
  }
  if (cfg.durationSec != null && !numIn(cfg.durationSec, 30, LIMITS.maxDurationSec)) {
    return 'durationSec must be a number between 30 and ' + LIMITS.maxDurationSec;
  }
  const dur = cfg.durationSec != null ? cfg.durationSec : 300;
  if (cfg.count != null && !(Number.isInteger(cfg.count) && cfg.count >= 1 && cfg.count <= LIMITS.maxDrones)) {
    return 'count must be an integer between 1 and ' + LIMITS.maxDrones;
  }
  const count = cfg.count != null ? cfg.count : 10;
  if (cfg.altitudeM != null && !numIn(cfg.altitudeM, 5, 1000)) return 'altitudeM must be 5..1000';
  if (cfg.spacingPct != null && !numIn(cfg.spacingPct, 30, 150)) return 'spacingPct must be 30..150';
  if (cfg.cityDensity != null && !numIn(cfg.cityDensity, 0, 100)) return 'cityDensity must be 0..100';
  if (cfg.cityHeight != null && !numIn(cfg.cityHeight, 0, 100)) return 'cityHeight must be 0..100';

  // Work budget in drone-seconds — the quantity that predicts compute.
  if (totalRuns * dur * count > LIMITS.maxTotalWorkDroneSec) {
    return 'total workload (' + (totalRuns * dur * count) + ' drone-seconds) exceeds the ' +
      LIMITS.maxTotalWorkDroneSec + ' budget — fewer runs, shorter duration, or a smaller fleet';
  }

  // Mission geometry: finite NUMBERS (isFinite alone coerces null to 0),
  // bounded so the terrain/search grids stay sane.
  const t = cfg.mission || {};
  if (!finiteNum(t.targetX) || !finiteNum(t.targetY)) return 'mission.targetX/targetY required (numbers, metres)';
  if (Math.abs(t.targetX) > LIMITS.maxCoordM || Math.abs(t.targetY) > LIMITS.maxCoordM) {
    return 'mission coordinates must be within ±' + LIMITS.maxCoordM + ' m';
  }
  return null;
}

function runOne(ctx, cfg, cell, seed) {
  const envMap = { open: [1, 2.5], suburban: [0.45, 4.5], urban: [0.2, 6.5] };
  const [envFactor, sigma] = envMap[cfg.env];
  const f = cfg.features || {};
  const s = ctx.makeSwarm({
    count: cfg.count || 10,
    airframe: A.AIRFRAMES.find(a => a.id === (cfg.airframe || 'q450')),
    radio: R.RADIOS.find(r => r.id === cfg.radio),
    envFactor,
    shadowSigmaDb: sigma,
    altitudeM: cell.altitudeM != null ? cell.altitudeM : (cfg.altitudeM || 70),
    deployFrac: cell.spacingPct != null ? cell.spacingPct / 100 : ((cfg.spacingPct || 80) / 100),
    targetX: cfg.mission.targetX, targetY: cfg.mission.targetY,
    seed,
    terrain: ctx.makeTerrain(cfg.terrain === 'osm' ? 'flat' : (cfg.terrain || 'flat'), {
      distM: Math.hypot(cfg.mission.targetX, cfg.mission.targetY),
      altM: cfg.altitudeM || 70, // Bug 26: hold terrain constant across sweep cells
      targetX: cfg.mission.targetX, targetY: cfg.mission.targetY, seed,
      density: (cfg.cityDensity != null ? cfg.cityDensity : 40) / 100,
      heightScale: (cfg.cityHeight != null ? cfg.cityHeight : 40) / 100,
    }),
    videoOn: !!f.videoOn, videoKbps: f.videoKbps || 0,
    spectrumAgility: !!f.spectrumAgility, lpiMode: !!f.lpiMode,
    adversaryMode: !!f.adversaryMode,
    relayWing: f.hetero ? (f.relayWing || 3) : 0,
    relayAirframe: f.relayAirframe ? A.AIRFRAMES.find(a => a.id === f.relayAirframe) : null,
    relayRadio: f.relayRadio ? R.RADIOS.find(r => r.id === f.relayRadio) : null,
    jammers: Array.isArray(f.jammers) ? JSON.parse(JSON.stringify(f.jammers)) : [],
    gpsZones: Array.isArray(f.gpsZones) ? JSON.parse(JSON.stringify(f.gpsZones)) : [],
  });
  let st = null;
  let freshSum = 0, ticks = 0;
  while (s.time < cfg.durationSec) {
    st = ctx.stepSwarm(s, SIM_DT_SEC);
    freshSum += st.freshCount; ticks++;
  }
  const vidTotal = s.net.vid.framesDelivered + s.net.vid.droppedFrames;
  return {
    cell: cell.name,
    seed,
    uptimePct: 100 * s.stats.connSec / Math.max(1e-9, s.stats.tSec),
    freshFrac: ticks ? freshSum / ticks / Math.max(1, s.drones.length) : 0,
    delivered: s.net.delivered,
    droppedPct: 100 * s.net.dropped / Math.max(1, s.net.delivered + s.net.dropped),
    vidLossPct: vidTotal ? 100 * s.net.vid.droppedFrames / vidTotal : null,
    maxNavErrM: s.maxNavErrM || 0,
  };
}

// Run a full batch. Returns plain data + rendered artifacts.
function runBatch(rawCfg, progress) {
  const err = validateConfig(rawCfg);
  if (err) throw new Error('invalid config: ' + err);
  const cfg = normalizeConfig(rawCfg);
  const cells = cfg.sweep;
  const seeds = cfg.seeds;
  const ctx = loadCore(); // one context reused across runs (state comes per-swarm)
  const rows = [];
  let done = 0;
  const total = cells.length * seeds.length;
  for (const cell of cells) {
    for (const seed of seeds) {
      rows.push(runOne(ctx, cfg, cell, seed));
      done++;
      if (progress) progress(done, total);
    }
  }
  const summary = stats.summarizeGroups(rows, r => r.cell);
  const meta = [
    '**Radio:** ' + cfg.radio + ' · **Env:** ' + cfg.env + ' · **Airframe:** ' + (cfg.airframe || 'q450') +
      ' × ' + (cfg.count || 10),
    '**Mission:** ' + Math.round(Math.hypot(cfg.mission.targetX, cfg.mission.targetY)) +
      ' m from base · **Duration:** ' + cfg.durationSec + ' s/run · **Terrain:** ' + (cfg.terrain || 'flat'),
  ];
  if (cfg.features && cfg.features.videoOn) meta.push('**Payload:** video backhaul at ' + (cfg.features.videoKbps || 250) + ' kbps');
  if (cfg.features && cfg.features.adversaryMode) meta.push('**Red team:** hunting jammers active');
  const md = stats.reportMd(cfg.label || 'unnamed sweep', summary, meta);
  const csv = stats.toCsv(rows);
  return { rows, summary, md, csv };
}

module.exports = { runBatch, validateConfig, normalizeConfig, LIMITS };

// --- CLI ----------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name, dflt) => {
    const i = args.indexOf('--' + name);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const cfgPath = getArg('config');
  const outDir = getArg('out', 'out');
  if (!cfgPath) {
    console.error('usage: node tools/batch.js --config batch/example.json [--out out/]');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  console.log('Running batch "' + (cfg.label || '?') + '"…');
  const t0 = Date.now();
  const res = runBatch(cfg, (d, t) => {
    if (d % 5 === 0 || d === t) process.stdout.write('  ' + d + '/' + t + '\r');
  });
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, 'batch-' + Date.now());
  fs.writeFileSync(base + '-report.md', res.md);
  fs.writeFileSync(base + '-runs.csv', res.csv);
  console.log('\n' + res.summary.map(g =>
    g.cell + ': uptime ' + (g.uptime ? g.uptime.mean.toFixed(1) + '% ±' + g.uptime.sd.toFixed(1) : '—')).join('\n'));
  console.log('\nWrote ' + base + '-report.md and -runs.csv in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
