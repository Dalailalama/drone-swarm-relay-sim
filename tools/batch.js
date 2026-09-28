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
  maxVideoKbps: 2000,           // the UI slider's maximum; above it a chunk fragments into thousands of packets
  // Relay-chain planning is paid per replan, independent of fleet size
  // (soak finding R8): cap the A* grid of one replan, and the total
  // grid-cell replans of the batch (~12 us per cell-replan measured).
  maxPlanGridCells: 1000000,
  maxTotalPlanCellReplans: 40000000,
};

// Mirrors the search box js/swarm.js planChain builds (not its internals):
// the grid cell follows the chain radio's usable range (>= 40 m, capped by
// the radio horizon) while the box follows the mission span, and the plan
// is redone every PLAN.replanSec. Extra padding planChain adds around active
// jammers is not estimated here.
const PLAN_REPLAN_SEC = 5;    // js/swarm.js PLAN.replanSec
const PLAN_C2_ANTENNA_M = 6;  // js/swarm.js C2_ANTENNA_M
function plannerGridCells(cfg, cell) {
  const env = { open: 1, suburban: 0.45, urban: 0.2 }[cfg.env];
  const f = cfg.features || {};
  const wing = f.hetero ? (f.relayWing ?? Math.min(3, cfg.count != null ? cfg.count : 10)) : 0;
  const chainId = wing > 0 && f.relayAirframe && f.relayRadio ? f.relayRadio : cfg.radio;
  const radio = R.RADIOS.find(r => r.id === chainId);
  const alt = cell.altitudeM != null ? cell.altitudeM : (cfg.altitudeM || 70);
  const usable = Math.min(R.usableRangeM(radio, env), R.radioHorizonM(PLAN_C2_ANTENNA_M, alt));
  const span = usable * (cell.spacingPct != null ? cell.spacingPct : (cfg.spacingPct || 80)) / 100;
  const cellM = Math.max(40, usable * 0.25);
  const pad = span * 1.5;
  const nx = Math.max(2, Math.ceil((Math.abs(cfg.mission.targetX) + 2 * pad) / cellM));
  const ny = Math.max(2, Math.ceil((Math.abs(cfg.mission.targetY) + 2 * pad) / cellM));
  return nx * ny;
}

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

function validateFeatures(f, count) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const has = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
  if (!object(f)) return 'features must be a JSON object';
  const booleans = ['videoOn', 'spectrumAgility', 'lpiMode', 'adversaryMode', 'hetero'];
  const fields = [...booleans, 'videoKbps', 'relayWing', 'relayAirframe', 'relayRadio', 'jammers', 'gpsZones'];
  for (const k of Object.keys(f)) {
    if (!fields.includes(k)) return 'features.' + k + ' is unknown';
  }
  for (const k of booleans) {
    if (has(f, k) && typeof f[k] !== 'boolean') return 'features.' + k + ' must be a boolean';
  }
  if (has(f, 'videoKbps') && !numIn(f.videoKbps, 0, LIMITS.maxVideoKbps)) return 'features.videoKbps must be a number in 0..' + LIMITS.maxVideoKbps;
  if (f.videoOn && has(f, 'videoKbps') && f.videoKbps === 0) return 'features.videoKbps must be positive when videoOn is true';
  if (has(f, 'relayWing') && !(Number.isInteger(f.relayWing) && numIn(f.relayWing, 0, count))) {
    return 'features.relayWing must be an integer in 0..count';
  }
  if (has(f, 'relayAirframe') && !A.AIRFRAMES.some(a => a.id === f.relayAirframe)) return 'features.relayAirframe is unknown';
  if (has(f, 'relayRadio') && !R.RADIOS.some(r => r.id === f.relayRadio)) return 'features.relayRadio is unknown';
  if (f.hetero && (!has(f, 'relayAirframe') || !has(f, 'relayRadio') || f.relayWing === 0)) {
    return 'features.hetero requires relayAirframe, relayRadio and a positive relayWing (default: up to 3)';
  }
  const bandFrequency = band => {
    const aliases = { all: null, sub1g: 915, '2.4g': 2400, '5g': 5800 };
    if (typeof band === 'string' && has(aliases, band)) return aliases[band];
    if (typeof band === 'string' && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(band)) band = Number(band);
    return numIn(band, 1, 100000) ? band : undefined;
  };
  for (const k of ['jammers', 'gpsZones']) {
    if (!has(f, k)) continue;
    if (!Array.isArray(f[k])) return 'features.' + k + ' must be an array';
    for (const [i, entry] of f[k].entries()) {
      const at = 'features.' + k + '[' + i + ']';
      if (!object(entry)) return at + ' must be a JSON object';
      const jammer = k === 'jammers';
      const allowed = ['id', 'x', 'y', 'on', ...(jammer
        ? ['erpDbm', 'altM', 'band', 'freqMHz', 'moveSpeedMs', 'detectRangeM'] : ['rM'])];
      for (const field of Object.keys(entry)) {
        if (!allowed.includes(field)) return at + '.' + field + ' is unknown';
      }
      if (!numIn(entry.x, -LIMITS.maxCoordM, LIMITS.maxCoordM) || !numIn(entry.y, -LIMITS.maxCoordM, LIMITS.maxCoordM)) {
        return at + '.x/y must be numbers within ±' + LIMITS.maxCoordM;
      }
      if (has(entry, 'id') && (typeof entry.id !== 'string' || !entry.id || entry.id.length > 100)) return at + '.id must be a nonempty string of at most 100 characters';
      if (has(entry, 'on') && typeof entry.on !== 'boolean') return at + '.on must be a boolean';
      if (!jammer) {
        if (!numIn(entry.rM, 0, LIMITS.maxCoordM)) return at + '.rM must be a number in 0..' + LIMITS.maxCoordM;
        continue;
      }
      if (!numIn(entry.erpDbm, -100, 100)) return at + '.erpDbm must be a number in -100..100';
      for (const [field, max] of [['altM', 10000], ['moveSpeedMs', 1000], ['detectRangeM', LIMITS.maxCoordM]]) {
        if (has(entry, field) && !(numIn(entry[field], 0, max) && entry[field] > 0)) return at + '.' + field + ' must be a positive number <= ' + max;
      }
      if (has(entry, 'freqMHz') && !numIn(entry.freqMHz, 1, 100000)) return at + '.freqMHz must be a number in 1..100000';
      if (has(entry, 'band') && bandFrequency(entry.band) === undefined) return at + '.band must be all|sub1g|2.4g|5g or a frequency in MHz (1..100000)';
      if (has(entry, 'freqMHz') && has(entry, 'band') && bandFrequency(entry.band) !== entry.freqMHz) return at + '.band and freqMHz must agree';
    }
  }
  return null;
}

const CONFIG_FIELDS = ['label', 'radio', 'env', 'airframe', 'terrain', 'count', 'durationSec', 'seeds', 'mission',
  'features', 'sweep', 'altitudeM', 'spacingPct', 'cityDensity', 'cityHeight'];

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'config must be a JSON object';
  // A field the engine never reads (say "windSpd") used to be dropped in
  // silence — the caller believed a different experiment ran (soak R13).
  for (const k of Object.keys(cfg)) {
    if (!CONFIG_FIELDS.includes(k)) return k + ' is unknown (fields: ' + CONFIG_FIELDS.join(', ') + ')';
  }
  if (cfg.label != null && (typeof cfg.label !== 'string' || cfg.label.length > 200)) return 'label must be a string of at most 200 characters';
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
    for (const k of Object.keys(c)) {
      if (!['name', 'altitudeM', 'spacingPct'].includes(k)) return 'cell "' + c.name + '": ' + k + ' is unknown (a cell varies altitudeM and/or spacingPct)';
    }
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
  if (Object.prototype.hasOwnProperty.call(cfg, 'features')) {
    const invalid = validateFeatures(cfg.features, count);
    if (invalid) return invalid;
  }
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
  for (const k of Object.keys(t)) {
    if (k !== 'targetX' && k !== 'targetY') return 'mission.' + k + ' is unknown (the base is fixed at 0,0)';
  }

  // Planning budget (soak finding R8): drone-seconds don't see it — one
  // drone for 30 s toward a 100 km objective on a short-range radio held a
  // worker until the 5-min timeout.
  let worstGrid = 0, planWork = 0;
  for (const c of cells) {
    const grid = plannerGridCells(cfg, c);
    worstGrid = Math.max(worstGrid, grid);
    planWork += grid * seeds.length * Math.ceil(dur / PLAN_REPLAN_SEC);
  }
  if (worstGrid > LIMITS.maxPlanGridCells) {
    return 're-planning the relay chain to a ' + (Math.hypot(t.targetX, t.targetY) / 1000).toFixed(1) + ' km objective on ' +
      cfg.radio + ' searches a ' + worstGrid + '-cell grid every ' + PLAN_REPLAN_SEC + ' sim-s (limit ' + LIMITS.maxPlanGridCells +
      ') — use a longer-range radio or a closer objective';
  }
  if (planWork > LIMITS.maxTotalPlanCellReplans) {
    return 'planning workload (' + planWork + ' grid-cell replans) exceeds the ' + LIMITS.maxTotalPlanCellReplans +
      ' budget — fewer runs, shorter duration, a closer objective or a longer-range radio';
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
    relayWing: f.hetero ? (f.relayWing ?? Math.min(3, cfg.count)) : 0,
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
  // One clear line and exit 1 — never a stack trace, and never a crash after
  // the work is done (soak finding R13).
  const fail = msg => { console.error(msg); process.exit(1); };
  if (!cfgPath) fail('usage: node tools/batch.js --config batch/example.json [--out out/]');
  let text, cfg;
  try { text = fs.readFileSync(cfgPath, 'utf8'); } catch (e) { fail('cannot read config ' + cfgPath + ': ' + e.message); }
  try { cfg = JSON.parse(text); } catch (e) { fail('config ' + cfgPath + ' is not valid JSON: ' + e.message); }
  const invalid = validateConfig(cfg);
  if (invalid) fail('invalid config: ' + invalid);
  // The output directory is settled BEFORE the run: an --out that names a
  // file used to throw away minutes of simulation at the very end.
  try {
    if (fs.existsSync(outDir) && !fs.statSync(outDir).isDirectory()) fail('--out ' + outDir + ' exists and is not a directory');
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) { fail('cannot create --out directory ' + outDir + ': ' + e.message); }
  console.log('Running batch "' + (cfg.label || '?') + '"…');
  const t0 = Date.now();
  let res;
  try {
    res = runBatch(cfg, (d, t) => {
      if (d % 5 === 0 || d === t) process.stdout.write('  ' + d + '/' + t + '\r');
    });
  } catch (e) { fail('batch failed: ' + e.message); }
  const base = path.join(outDir, 'batch-' + Date.now());
  fs.writeFileSync(base + '-report.md', res.md);
  fs.writeFileSync(base + '-runs.csv', res.csv);
  console.log('\n' + res.summary.map(g =>
    g.cell + ': uptime ' + (g.uptime ? g.uptime.mean.toFixed(1) + '% ±' + g.uptime.sd.toFixed(1) : '—')).join('\n'));
  console.log('\nWrote ' + base + '-report.md and -runs.csv in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
