const { test } = require('node:test');
const assert = require('node:assert');
const { calcStats } = require('../bench/run.js');

test('Item 6: calcStats produces correct distribution metrics', () => {
  const samples = [10, 20, 30, 40, 50];
  const stats = calcStats(samples);

  assert.strictEqual(stats.min, 10);
  assert.strictEqual(stats.max, 50);
  assert.strictEqual(stats.mean, 30);
  assert.strictEqual(stats.median, 30);
  assert.strictEqual(stats.p95, 50);
  assert.ok(Math.abs(stats.sd - Math.sqrt(200)) < 1e-4);
});

test('Item 6: calcStats handles empty and single-element inputs gracefully', () => {
  const emptyStats = calcStats([]);
  assert.strictEqual(emptyStats.mean, 0);
  assert.strictEqual(emptyStats.sd, 0);

  const singleStats = calcStats([42]);
  assert.strictEqual(singleStats.min, 42);
  assert.strictEqual(singleStats.max, 42);
  assert.strictEqual(singleStats.mean, 42);
  assert.strictEqual(singleStats.median, 42);
  assert.strictEqual(singleStats.sd, 0);
});
