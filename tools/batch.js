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

// Guardrails so a stray config can't wedge the server for an hour.
const LIMITS = {
  maxCells: 40,
  maxSeedsPerCell: 20,
  maxTotalRuns: 200,
  maxDurationSec: 1800,
};

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'config must be a JSON object';
  if (!R.RADIOS.some(r => r.id === cfg.radio)) return 'unknown radio: ' + cfg.radio;
  const envs = { open: [1, 2.5], suburban: [0.45, 4.5], urban: [0.2, 6.5] };
  if (!envs[cfg.env]) return 'env must be open|suburban|urban';
  if (!A.AIRFRAMES.some(a => a.id === (cfg.airframe || 'q450'))) return 'unknown airframe';
  const cells = Array.isArray(cfg.sweep) ? cfg.sweep : [{ name: 'base' }];
  if (!cells.length || cells.length > LIMITS.maxCells) return 'sweep must have 1..' + LIMITS.maxCells + ' cells';
  for (const c of cells) if (!c.name) return 'every sweep cell needs a name';
  const seeds = Array.isArray(cfg.seeds) ? cfg.seeds : [101, 102, 103];
  if (!seeds.length || seeds.length > LIMITS.maxSeedsPerCell) {
    return 'seeds must be a non-empty array of at most ' + LIMITS.maxSeedsPerCell;
  }
  if (cells.length * seeds.length > LIMITS.maxTotalRuns) {
    return 'total runs (' + cells.length * seeds.length + ') exceeds cap ' + LIMITS.maxTotalRuns;
  }
  const dur = Math.min(LIMITS.maxDurationSec, cfg.durationSec || 300);
  if (!(dur >= 30)) return 'durationSec must be >= 30';
  // Mission geometry sanity
  const t = cfg.mission || {};
  if (!isFinite(t.targetX) || !isFinite(t.targetY)) return 'mission.targetX/targetY required (metres)';
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
      altM: cell.altitudeM || cfg.altitudeM || 70,
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
    st = ctx.stepSwarm(s, 0.25);
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
function runBatch(cfg, progress) {
  const err = validateConfig(cfg);
  if (err) throw new Error('invalid config: ' + err);
  const cells = Array.isArray(cfg.sweep) ? cfg.sweep : [{ name: 'base' }];
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

module.exports = { runBatch, validateConfig, LIMITS };

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
