const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { SIM_DT_SEC } = require('../js/swarm.js');
const { replayMission, parseCapture } = require('../js/replay.js');
const { exportCaptureJSONL, recordUserAction } = require('../js/net.js');

test('Item 8: exportCaptureJSONL includes seed, settings, and timestamped user actions', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({
    count: 6,
    seed: 505,
    radio: R.RADIOS[0],
    airframe: A.AIRFRAMES[0],
    captureOn: true,
  });

  // Step 2 seconds
  for (let t = 0; t < 2.0; t += SIM_DT_SEC) ctx.stepSwarm(s, SIM_DT_SEC);

  // Kill drone DR-3 and record user action
  const d3 = s.drones.find(d => d.id === 'DR-3');
  recordUserAction(s, { type: 'kill', id: 'DR-3' });
  ctx.killDrone(s, d3);

  // Step to 4 seconds
  for (let t = 2.0; t < 4.0; t += SIM_DT_SEC) ctx.stepSwarm(s, SIM_DT_SEC);

  // Move target
  recordUserAction(s, { type: 'target', x: 2200, y: -500 });
  s.target.x = 2200;
  s.target.y = -500;

  // Step to 5 seconds
  for (let t = 4.0; t < 5.0; t += SIM_DT_SEC) ctx.stepSwarm(s, SIM_DT_SEC);

  const jsonl = exportCaptureJSONL(s);
  assert.ok(typeof jsonl === 'string' && jsonl.length > 0);

  const lines = parseCapture(jsonl);
  assert.ok(lines.length > 1);

  const meta = lines[0];
  assert.strictEqual(meta.ev, 'meta');
  assert.strictEqual(meta.seed, 505);
  assert.strictEqual(meta.settings.count, 6);
  assert.strictEqual(meta.settings.radio, R.RADIOS[0].id);
  assert.strictEqual(meta.userActions.length, 2);
  assert.strictEqual(meta.userActions[0].type, 'kill');
  assert.strictEqual(meta.userActions[0].id, 'DR-3');
  assert.strictEqual(meta.userActions[1].type, 'target');
  assert.strictEqual(meta.userActions[1].x, 2200);
});

test('Item 8: replayMission deterministically reproduces mission trajectory and network outcomes', () => {
  const ctx = loadCore();
  const originalSwarm = ctx.makeSwarm({
    count: 4,
    seed: 888,
    radio: R.RADIOS[0],
    airframe: A.AIRFRAMES[0],
    captureOn: true,
  });

  // Run original simulation with timestamped actions
  while (originalSwarm.time < 6.0) {
    if (Math.abs(originalSwarm.time - 2.0) < 1e-4) {
      recordUserAction(originalSwarm, { type: 'target', x: 1800, y: -200 });
      originalSwarm.target.x = 1800;
      originalSwarm.target.y = -200;
    }
    if (Math.abs(originalSwarm.time - 3.5) < 1e-4) {
      const d2 = originalSwarm.drones.find(d => d.id === 'DR-2');
      recordUserAction(originalSwarm, { type: 'kill', id: 'DR-2' });
      ctx.killDrone(originalSwarm, d2);
    }
    ctx.stepSwarm(originalSwarm, SIM_DT_SEC);
  }

  const captureJsonl = exportCaptureJSONL(originalSwarm);

  // Replay the mission using the exported capture
  const replayed = replayMission(captureJsonl, { untilTime: 6.0, core: ctx });

  assert.strictEqual(replayed.time, originalSwarm.time);
  assert.strictEqual(replayed.delivered, originalSwarm.net.delivered);
  assert.strictEqual(replayed.dropped, originalSwarm.net.dropped);

  for (let i = 0; i < originalSwarm.drones.length; i++) {
    const origD = originalSwarm.drones[i];
    const repD = replayed.dronePositions.find(p => p.id === origD.id);
    assert.ok(repD, 'Drone ' + origD.id + ' must be in replayed state');
    assert.strictEqual(repD.mode, origD.mode, 'Drone ' + origD.id + ' mode must match');
    assert.ok(Math.abs(repD.x - origD.x) < 1e-4, 'Drone ' + origD.id + ' X coordinate must reproduce exactly');
    assert.ok(Math.abs(repD.y - origD.y) < 1e-4, 'Drone ' + origD.id + ' Y coordinate must reproduce exactly');
    assert.ok(Math.abs(repD.batteryPct - origD.batteryPct) < 1e-4, 'Battery percentage must reproduce exactly');
  }
});
