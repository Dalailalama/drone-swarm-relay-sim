#!/usr/bin/env node
// Headless and browser-responsiveness benchmark suite.
//
//   node bench/run.js [--quick]
//
// Simulates fixed missions at growing fleet sizes through the SAME code the
// browser runs (loaded headlessly via the shared vm harness), collects
// statistical distributions across multiple runs, measures browser UI
// responsiveness under load via the DOM harness, and writes:
//   - bench/results.json: machine-readable raw samples and stats
//   - bench/BASELINE.md: formatted comparison table with git commit & environment

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { loadCore } = require('../test/helpers/sim.js');
const { loadUI } = require('../test/helpers/dom.js');

const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { SIM_DT_SEC } = require('../js/swarm.js');

const args = process.argv.slice(2);
const quick = args.includes('--quick');

const SAMPLES = quick ? 2 : 3;
const SIM_SECONDS = quick ? 15 : 90;
const FLEET_SIZES = quick ? [10, 50] : [10, 50, 100, 140];
const BROWSER_FLEET_SIZES = quick ? [10, 50] : [10, 50, 100];
const BROWSER_FRAMES = quick ? 30 : 60;

function calcStats(vals) {
  if (!vals.length) return { min: 0, max: 0, mean: 0, median: 0, p95: 0, sd: 0 };
  const sorted = [...vals].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mean = vals.reduce((sum, v) => sum + v, 0) / vals.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[p95Idx];
  const variance = vals.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / vals.length;
  const sd = Math.sqrt(variance);
  return { min, max, mean, median, p95, sd, variance };
}

function getCommitId() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return 'unknown';
  }
}

function runOnce(n, seedOffset) {
  const ctx = loadCore();
  const s = ctx.makeSwarm({
    count: n,
    airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
    radio: R.RADIOS.find(r => r.id === 'rfd900x'),
    envFactor: 1,
    targetX: 2400, targetY: -600,
    altitudeM: 70,
    seed: 900 + n + seedOffset,
    videoOn: true,
    videoKbps: 250,
  });
  let st = null;
  const mem0 = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  while (s.time < SIM_SECONDS) st = ctx.stepSwarm(s, SIM_DT_SEC);
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const mem1 = process.memoryUsage().heapUsed;
  return {
    n,
    wallMs,
    msPerTick: wallMs / (SIM_SECONDS / SIM_DT_SEC),
    speedup: SIM_SECONDS / (wallMs / 1000),
    delivered: s.net.delivered,
    droppedPct: 100 * s.net.dropped / Math.max(1, s.net.delivered + s.net.dropped),
    uptimePct: 100 * (s.stats.fleetConnSec || 0) / s.stats.tSec,
    heapMb: mem1 / 1e6,
    heapDeltaMb: (mem1 - mem0) / 1e6,
  };
}

function runHeadlessSuite() {
  console.log(`\n=== Headless Scale Benchmark (${SAMPLES} runs, ${SIM_SECONDS}s per run) ===`);
  const results = [];
  for (const n of FLEET_SIZES) {
    process.stdout.write(`  n=${n} [${SAMPLES} samples] … `);
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      samples.push(runOnce(n, i * 17));
    }
    const msTicks = samples.map(s => s.msPerTick);
    const speedups = samples.map(s => s.speedup);
    const deliveries = samples.map(s => s.delivered);
    const drops = samples.map(s => s.droppedPct);
    const uptimes = samples.map(s => s.uptimePct);

    const statMsTick = calcStats(msTicks);
    const statSpeedup = calcStats(speedups);

    console.log(`${statMsTick.mean.toFixed(2)} ± ${statMsTick.sd.toFixed(2)} ms/tick (${statSpeedup.mean.toFixed(1)}× realtime)`);

    results.push({
      n,
      samplesCount: SAMPLES,
      msPerTick: statMsTick,
      speedup: statSpeedup,
      deliveredMean: calcStats(deliveries).mean,
      droppedPctMean: calcStats(drops).mean,
      uptimePctMean: calcStats(uptimes).mean,
      rawSamples: samples,
    });
  }
  return results;
}

function runBrowserSuite() {
  console.log(`\n=== Browser Responsiveness Benchmark (${BROWSER_FRAMES} frames per fleet) ===`);
  const results = [];
  for (const n of BROWSER_FLEET_SIZES) {
    process.stdout.write(`  UI n=${n} (${BROWSER_FRAMES} frames) … `);
    const { ctx, el, fire } = loadUI();
    el('countRange').value = n;
    fire('countRange', 'change');

    // Warm up 5 frames
    for (let i = 0; i < 5; i++) ctx.__raf.pump(16);

    const mem0 = process.memoryUsage().heapUsed;
    const frameTimes = [];
    for (let i = 0; i < BROWSER_FRAMES; i++) {
      const t0 = process.hrtime.bigint();
      ctx.__raf.pump(16);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      frameTimes.push(ms);
    }
    const mem1 = process.memoryUsage().heapUsed;
    const stats = calcStats(frameTimes);
    const fpsEst = stats.mean > 0 ? Math.min(60, 1000 / stats.mean) : 60;

    console.log(`${stats.mean.toFixed(2)} ± ${stats.sd.toFixed(2)} ms/frame (p95: ${stats.p95.toFixed(2)} ms, est: ${fpsEst.toFixed(1)} FPS)`);

    results.push({
      n,
      frames: BROWSER_FRAMES,
      frameLatencyMs: stats,
      fpsEst,
      heapDeltaMb: (mem1 - mem0) / 1e6,
      heapTotalMb: mem1 / 1e6,
      rawSamplesMs: frameTimes,
    });
  }
  return results;
}

function generateMarkdown(envInfo, headlessResults, browserResults) {
  const headlessRows = headlessResults.map(r => {
    return `| ${r.n} | ${r.msPerTick.mean.toFixed(2)} ± ${r.msPerTick.sd.toFixed(2)} | ${r.msPerTick.median.toFixed(2)} | ${r.msPerTick.p95.toFixed(2)} | ${r.speedup.mean.toFixed(1)}× | ${Math.round(r.deliveredMean).toLocaleString()} | ${r.uptimePctMean.toFixed(0)}% | ${r.droppedPctMean.toFixed(1)}% |`;
  });

  const browserRows = browserResults.map(r => {
    return `| ${r.n} | ${r.frameLatencyMs.mean.toFixed(2)} ± ${r.frameLatencyMs.sd.toFixed(2)} | ${r.frameLatencyMs.median.toFixed(2)} | ${r.frameLatencyMs.p95.toFixed(2)} | ${r.frameLatencyMs.max.toFixed(2)} | ${r.fpsEst.toFixed(1)} | ${r.heapTotalMb.toFixed(1)} |`;
  });

  return [
    '# Scale & Responsiveness Benchmark — Baseline',
    '',
    '_Generated by `node bench/run.js`. Commit the diff whenever the core simulation or UI loop changes._',
    '',
    '## Environment',
    `- **Commit**: \`${envInfo.commit}\``,
    `- **Node**: ${envInfo.node} · ${envInfo.platform} ${envInfo.arch}`,
    `- **CPU**: ${envInfo.cpu} (${envInfo.cores} cores)`,
    `- **RAM**: ${envInfo.totalRamGb} GB`,
    `- **Date**: ${envInfo.date}`,
    '',
    '## Headless Fleet Scale Benchmark',
    `- **Mission**: RFD900x mesh @ 250 kbps video backhaul, 2.4 km objective, ${SIM_SECONDS} sim-seconds, dt ${SIM_DT_SEC}`,
    `- **Samples**: ${SAMPLES} independent runs per fleet size`,
    '',
    '| Fleet | ms/tick (mean ± sd) | Median | p95 | × Realtime | Packets | Fleet Uptime | Drop |',
    '|---|---|---|---|---|---|---|---|',
    ...headlessRows,
    '',
    '## Browser UI Responsiveness Under Load',
    `- **Scenario**: Interactive page lifecycle, DOM fleet table updates, 2D canvas viewport, diagnostics, and metrics rendering`,
    `- **Frames**: ${BROWSER_FRAMES} frames per fleet size (16 ms target)`,
    '',
    '| Fleet | Frame Latency ms (mean ± sd) | Median | p95 | Max | Est. FPS | Heap (MB) |',
    '|---|---|---|---|---|---|---|',
    ...browserRows,
    '',
    '## Observations & Constraints',
    '1. **Shared Channel Dominance**: At fleet sizes N > 50, contention on the broadcast channel dominates execution time over kinematics.',
    '2. **Keyed DOM Updates**: Keyed row patching in `fleetBody` ensures DOM manipulation overhead remains linear with active fleet changes.',
    '3. **Viewport Culling**: Off-screen terrain building geometry is culled before rasterization, bounding canvas draw calls.',
    '',
  ].join('\n');
}

function main() {
  const commitId = getCommitId();
  const envInfo = {
    commit: commitId,
    node: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0] ? os.cpus()[0].model.trim() : 'unknown',
    cores: os.cpus().length,
    totalRamGb: (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1),
    date: new Date().toISOString(),
  };

  const headlessResults = runHeadlessSuite();
  const browserResults = runBrowserSuite();

  const payload = {
    timestamp: envInfo.date,
    environment: envInfo,
    headless: headlessResults,
    browserResponsiveness: browserResults,
  };

  const jsonOut = path.join(__dirname, 'results.json');
  fs.writeFileSync(jsonOut, JSON.stringify(payload, null, 2) + '\n');
  console.log('\nWrote ' + jsonOut);

  const md = generateMarkdown(envInfo, headlessResults, browserResults);
  const mdOut = path.join(__dirname, 'BASELINE.md');
  fs.writeFileSync(mdOut, md);
  console.log('Wrote ' + mdOut);
}

if (require.main === module) {
  main();
}

module.exports = {
  calcStats,
  runOnce,
  runBrowserResponsiveness: (n, frames) => {
    const r = runBrowserSuite();
    return r.find(x => x.n === n);
  },
};
