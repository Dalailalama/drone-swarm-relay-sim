// UI boot tests. Everything else in test/ drives the sim through helpers/sim.js
// (pure modules only); this file boots the *page* — every script index.html
// loads, main.js included — inside the DOM harness in helpers/dom.js, so the
// wiring between the controls and the sim is covered too.
//
// Scenario route: main.js keeps applyScenario() private inside its IIFE, so the
// second test goes in the way a user does — set the hidden file input's files
// and fire its 'change' listener, which builds a FileReader and hands the JSON
// to applyScenario. The harness FileReader is synchronous, so the swarm is
// rebuilt by the time fire() returns.

const { test } = require('node:test');
const assert = require('node:assert');

const { loadUI, makeFile } = require('./helpers/dom.js');
const { SCENARIO_PACK } = require('../js/scenarios.js');

test('the whole UI boots under the DOM harness', () => {
  const { ctx, el } = loadUI();

  assert.ok(ctx.sim, 'main.js must expose window.sim');
  assert.ok(ctx.sim.swarm, 'window.sim must hold a swarm');
  assert.ok(ctx.sim.swarm.drones.length > 0,
    'boot must launch a swarm, got ' + ctx.sim.swarm.drones.length + ' drones');
  // index.html ships countRange at 10, and the boot path reads it.
  assert.strictEqual(ctx.sim.swarm.drones.length, +el('countRange').value,
    'fleet size must follow the drones slider');
  assert.strictEqual(el('countOut').textContent, el('countRange').value);

  // Boot ran to the end: the last statements queue a frame and mark 5x active.
  assert.ok(ctx.__raf.pending > 0, 'the render loop must be queued');
  assert.ok(el('kpiClock').textContent.startsWith('T+'), 'panels wired');
  assert.ok(el('specCard').innerHTML.includes('Frequency'), 'radio spec card rendered');
  assert.deepStrictEqual(ctx.__alerts, [], 'boot must not raise an alert');
});

test('a scenario JSON can be applied through the UI path', () => {
  const { ctx, el, fire } = loadUI();

  const pack = SCENARIO_PACK.find(p => p.id === 'ddil-full');
  const sc = Object.assign({}, pack.scenario, { count: 17 });
  const before = ctx.sim.swarm;

  // The visible button only opens the picker; the picker's result arrives as a
  // 'change' on the hidden input, which is what we simulate here.
  fire('loadScenarioBtn', 'click');
  el('loadScenarioInput').files = [makeFile('scenario.json', JSON.stringify(sc))];
  fire('loadScenarioInput', 'change');

  assert.deepStrictEqual(ctx.__alerts, [], 'the file must parse and apply cleanly');
  assert.notStrictEqual(ctx.sim.swarm, before, 'applying a scenario relaunches the swarm');
  assert.strictEqual(ctx.sim.swarm.drones.length, 17, 'fleet size comes from the file');
  assert.strictEqual(el('countRange').value, '17', 'the control reflects the loaded scenario');
  assert.strictEqual(ctx.sim.radio.id, sc.radio, 'radio selection comes from the file');
  assert.strictEqual(el('altRange').value, String(sc.altitudeM));
  assert.strictEqual(ctx.sim.swarm.target.x, sc.target.x, 'objective placed from the file');
  assert.strictEqual(ctx.sim.swarm.target.y, sc.target.y);
  assert.strictEqual(ctx.sim.swarm._terrainSeed, sc.seed, 'seeded map is reproduced exactly');
  assert.strictEqual(ctx.sim.swarm.jammers.length, sc.jammers.length, 'interference sources placed');
  assert.strictEqual(ctx.sim.swarm.gpsZones.length, (sc.gpsZones || []).length, 'GPS outages placed');
  assert.strictEqual(el('loadScenarioInput').value, '', 'input cleared so the same file can reload');

  // The loaded scenario keeps running: pump a few frames by hand.
  for (let i = 0; i < 5; i++) ctx.__raf.pump(16);
  assert.ok(ctx.sim.swarm.time > 0, 'pumped frames advance sim time');
});
