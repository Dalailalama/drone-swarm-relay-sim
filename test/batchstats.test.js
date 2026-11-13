// Audit findings on the batch report / CSV layer (js/batchstats.js) and the
// compare tool's spread: contact precision, formula injection, sample SD.
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../js/batchstats.js');

test('audit: the C2 contact column is a percentage, so 0.951 is not rounded up to 1.0', () => {
  const rows = [0.951, 0.949, 0.952].map(f => ({ cell: 'A', uptimePct: 90, droppedPct: 1, freshFrac: f }));
  const md = S.reportMd('t', S.summarizeGroups(rows, r => r.cell), []);
  assert.ok(md.includes('95.1%'), md);
});

test('audit: CSV cells that a spreadsheet would evaluate are neutralized; | cannot add a Markdown column', () => {
  const csv = S.toCsv([{ cell: '=HYPERLINK("http://x","y")', seed: 1 }, { cell: '+1', seed: 2 }, { cell: '@a', seed: 3 }, { cell: '-1', seed: 4 }]);
  const lines = csv.split('\n').slice(1);
  for (const l of lines) assert.ok(/^"?'/.test(l), l);
  const md = S.reportMd('t', S.summarizeGroups([{ cell: 'a|b', uptimePct: 1 }], r => r.cell), []);
  const row = md.split('\n').find(l => l.startsWith('| a'));
  assert.strictEqual(row.split(/(?<!\\)\|/).length - 2, 6, row);
});

test('audit: compare reports the same sample SD as the batch report', () => {
  const { calcStats } = require('../tools/compare.js');
  assert.strictEqual(calcStats([90, 95, 100, 80, 85]).sd, S.stdev([90, 95, 100, 80, 85]));
  assert.ok(Math.abs(S.stdev([90, 95, 100, 80, 85]) - 7.905694150420948) < 1e-12);
});

// audit tools-data-integrations/batch-report-p05-p95-small-n: at the run
// counts the engine allows (3-20 seeds per cell) a sample p05/p95 understates
// the tails, and a bare '±sd' is not a confidence interval.
test('audit: the batch report gives a t-based 95% CI with its n, and no sample p05/p95 below 20 runs', () => {
  const xs = [90, 95, 100, 80, 85];
  const md = S.reportMd('t', S.summarizeGroups(xs.map(u => ({ cell: 'A', uptimePct: u })), r => r.cell), []);
  assert.ok(md.includes('95% CI') && md.includes('n=5'), md);
  assert.ok(!md.includes('p05') && !md.includes('p95'), md);
  // t(0.975, 4) = 2.776: half-width 2.776 * 7.906 / sqrt(5) = 9.8
  assert.ok(md.includes('[95% CI 80.2, 99.8]'), md);
  assert.ok(md.includes('min 80.0, max 100.0'), md);
  const one = S.reportMd('t', S.summarizeGroups([{ cell: 'B', uptimePct: 70 }], r => r.cell), []);
  assert.ok(!one.includes('±0.0') && one.includes('n=1'), one);
  const many = S.reportMd('t', S.summarizeGroups(Array.from({ length: 20 }, (_, i) => ({ cell: 'C', uptimePct: i })), r => r.cell), []);
  assert.ok(many.includes('p05') && many.includes('n=20'), many);
  const top = S.reportMd('t', S.summarizeGroups([96, 100, 100].map(u => ({ cell: 'D', uptimePct: u })), r => r.cell), []);
  assert.ok(top.includes(', 100.0]'), 'a percentage interval stops at 100%: ' + top);
});

test('audit: t critical values match the table and approach the normal 1.96', () => {
  assert.strictEqual(S.tCrit975(2), 4.303);
  assert.strictEqual(S.tCrit975(4), 2.776);
  assert.ok(Math.abs(S.tCrit975(60) - 2.000) < 0.003 && Math.abs(S.tCrit975(120) - 1.980) < 0.003);
  assert.strictEqual(S.ci95([5]), null);
});
