const { test } = require('node:test');
const assert = require('node:assert');
const { compareScenarios, resolveScenario } = require('../tools/compare.js');

test('Item 10: resolveScenario resolves known DDIL pack scenarios and custom objects', () => {
  const s1 = resolveScenario('ddil-disrupted');
  assert.strictEqual(s1.id, 'ddil-disrupted');
  assert.ok(s1.scenario.radio);

  const custom = { id: 'custom-1', name: 'Custom Test', radio: 'rfd900x', count: 4, target: { x: 1000, y: 0 } };
  const s2 = resolveScenario(custom);
  assert.strictEqual(s2.id, 'custom-1');
  assert.strictEqual(s2.scenario.radio, 'rfd900x');
});

test('Item 10: compareScenarios computes uptime, arrival, packet loss, energy and variance across identical seeds', () => {
  const result = compareScenarios(['ddil-disrupted', 'ddil-denied'], {
    seeds: [101, 102],
    durationSec: 15,
  });

  assert.strictEqual(result.seeds.length, 2);
  assert.strictEqual(result.results.length, 2);

  for (const r of result.results) {
    assert.ok(typeof r.uptime.mean === 'number');
    assert.ok(typeof r.uptime.sd === 'number');
    assert.ok(typeof r.droppedPct.mean === 'number');
    assert.ok(typeof r.energyWh.mean === 'number');
    assert.strictEqual(r.runs.length, 2);
  }

  assert.ok(result.markdown.includes('Scenario Comparison Dashboard'));
  assert.ok(result.markdown.includes('ddil-disrupted') || result.markdown.includes('Disrupted'));
  assert.ok(result.text.includes('Scenario Comparison Dashboard'));
});
