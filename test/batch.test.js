// Batch Monte Carlo tests — stats math, end-to-end mini-batch through the
// REAL engine (same vm harness as the browser code), and config validation.

const { test } = require('node:test');
const assert = require('node:assert');

const S = require('../js/batchstats.js');
const B = require('../tools/batch.js');

test('stats: mean/stdev/percentile on known data', () => {
  assert.strictEqual(S.mean([2, 4, 6]), 4);
  const sd = S.stdev([2, 4, 6, 8]);
  assert.ok(Math.abs(sd - Math.sqrt(20 / 3)) < 1e-12);
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.strictEqual(S.percentile(xs, 50), 5.5);
  assert.ok(Math.abs(S.percentile(xs, 95) - 9.55) < 1e-9);
  assert.strictEqual(S.percentile([], 90), NaN);
});

test('summarizeGroups groups rows and reports distributions', () => {
  const rows = [
    { cell: 'a', uptimePct: 100, droppedPct: 1, vidLossPct: 0, freshFrac: 1 },
    { cell: 'a', uptimePct: 80, droppedPct: 3, vidLossPct: 10, freshFrac: 0.9 },
    { cell: 'b', uptimePct: 40, droppedPct: 9, vidLossPct: null, freshFrac: 0.5 },
  ];
  const sum = S.summarizeGroups(rows, r => r.cell);
  const a = sum.find(g => g.cell === 'a');
  assert.strictEqual(a.runs, 2);
  assert.ok(Math.abs(a.uptime.mean - 90) < 1e-9);
  assert.ok(Math.abs(a.uptime.min - 80) < 1e-9);
  // null metrics come back as a null group rather than poisoning the mean
  const b = sum.find(g => g.cell === 'b');
  assert.strictEqual(b.vidLoss, null);
});

function miniConfig() {
  return {
    label: 'mini sweep',
    radio: 'rfd900x',
    env: 'suburban',
    airframe: 'q450',
    terrain: 'flat',
    count: 6,
    // Long enough for the flock to REACH the objective and hold: uptimePct
    // is objective uptime (finding #6) — a run ending mid-transit reads 0%.
    durationSec: 150,
    seeds: [11, 12],
    mission: { targetX: 700, targetY: -150 },
    features: { videoOn: true, videoKbps: 250 },
    sweep: [
      { name: 'low', altitudeM: 45 },
      { name: 'high', altitudeM: 110 },
    ],
  };
}

test('runBatch end-to-end: one row per cell×seed, summary per cell', () => {
  const res = B.runBatch(miniConfig());
  assert.strictEqual(res.rows.length, 4); // 2 cells × 2 seeds
  for (const r of res.rows) {
    assert.ok(isFinite(r.uptimePct) && r.uptimePct >= 0 && r.uptimePct <= 100);
    assert.ok(r.freshFrac >= 0 && r.freshFrac <= 1.000001);
    assert.ok(Number.isInteger(r.delivered) && r.delivered > 0);
  }
  assert.strictEqual(res.summary.length, 2);
  const high = res.summary.find(g => g.cell === 'high');
  assert.ok(high.uptime.mean >= 30, 'long-range radio at altitude must hold a link');
  // Artifacts render
  assert.ok(res.md.includes('# Monte Carlo batch report'));
  assert.ok(res.md.includes('| low |'));
  assert.ok(res.csv.startsWith('cell,seed,uptimePct'));
  assert.strictEqual(res.csv.trim().split('\n').length, 5); // header + 4 rows
});

test('determinism: same config+seeds -> identical results', () => {
  const cfg = miniConfig();
  const a = B.runBatch(cfg);
  const b = B.runBatch(cfg);
  assert.deepStrictEqual(
    a.rows.map(r => [r.cell, r.seed, Math.round(r.uptimePct * 100)]),
    b.rows.map(r => [r.cell, r.seed, Math.round(r.uptimePct * 100)]));
});

test('config validation rejects garbage loudly', () => {
  assert.ok(B.validateConfig({ radio: 'nope', env: 'open', mission: { targetX: 1, targetY: 1 } }));
  assert.ok(B.validateConfig(Object.assign(miniConfig(), { seeds: [] })));
  const big = miniConfig();
  big.sweep = Array.from({ length: 15 }, (_, i) => ({ name: 'c' + i }));
  big.seeds = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.ok(B.validateConfig(big).includes('cap'), 'total-run cap enforced');
  assert.strictEqual(B.validateConfig(miniConfig()), null, 'the good config passes');
});
