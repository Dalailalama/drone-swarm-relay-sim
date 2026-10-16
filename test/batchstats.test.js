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
