const { test } = require('node:test');
const assert = require('node:assert');
const { loadUI } = require('./helpers/dom.js');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

test('Item 9: explainDroneDecision provides plain-English reasons and measurements for all drone states', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 5, seed: 101, radio: R.RADIOS[0], airframe: A.AIRFRAMES[0] });

  const d = s.drones[0];
  d.order = { role: 'relay', upstream: 'C2', slotIndex: 0 };
  d.upMarginEma = 12.4;
  d.mode = 'ok';

  // 1. Relay role
  const expRelay = ctx.explainDroneDecision(s, d);
  assert.strictEqual(expRelay.id, d.id);
  assert.strictEqual(expRelay.mode, 'ok');
  assert.strictEqual(expRelay.role, 'relay');
  assert.ok(expRelay.summary.includes('Relay station: bridging C2 to downstream fleet'));
  assert.strictEqual(expRelay.marginDb, 12.4);

  // 2. Objective loiter
  d.order = { role: 'mission', upstream: 'DR-1' };
  d.upMarginEma = 8.5;
  const expMission = ctx.explainDroneDecision(s, d);
  assert.ok(expMission.summary.includes('Objective loiter: orbiting target'));

  // 3. Tether active
  d.tethered = true;
  const expTether = ctx.explainDroneDecision(s, d);
  assert.ok(expTether.summary.includes('Tethered: upstream margin to DR-1 degraded'));
  d.tethered = false;

  // 4. Hold mode (link loss stage 1)
  d.mode = 'hold';
  d.lastC2 = s.time - 15;
  const expHold = ctx.explainDroneDecision(s, d);
  assert.strictEqual(expHold.mode, 'hold');
  assert.ok(expHold.summary.includes('Holding position: C2 link lost'));

  // 5. Relink fallback (link loss stage 2)
  d.mode = 'relink';
  d.relinkAttempt = 2;
  const expRelink = ctx.explainDroneDecision(s, d);
  assert.strictEqual(expRelink.mode, 'relink');
  assert.ok(expRelink.summary.includes('Regaining link (attempt 2/3)'));

  // 6. RTL mode
  d.mode = 'rtl';
  const expRtl = ctx.explainDroneDecision(s, d);
  assert.strictEqual(expRtl.mode, 'rtl');
  assert.ok(expRtl.summary.includes('Returning to C2: failsafe link recovery'));

  // 7. RTB mode (battery low)
  d.mode = 'rtb';
  d.batteryPct = 22.5;
  const expRtb = ctx.explainDroneDecision(s, d);
  assert.strictEqual(expRtb.mode, 'rtb');
  assert.ok(expRtb.summary.includes('Returning to base: low battery'));

  // 8. Landed mode
  d.mode = 'landed';
  const expLanded = ctx.explainDroneDecision(s, d);
  assert.strictEqual(expLanded.mode, 'landed');
  assert.ok(expLanded.summary.includes('Landed on base pad'));

  // 9. Dead mode
  d.mode = 'dead';
  const expDead = ctx.explainDroneDecision(s, d);
  assert.strictEqual(expDead.mode, 'dead');
  assert.ok(expDead.summary.includes('Vehicle down'));
});

test('Item 9 & 7: UI renders decision card and maintains keyed DOM rows for fleet', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;

  // Initial state: no drone selected
  assert.ok(ui.el('droneDecisionCard').textContent.includes('Select a drone'));

  // Pump frames to render fleet rows initially
  ui.ctx.__raf.pump(200);
  ui.ctx.__raf.pump(200);

  // Select drone DR-1
  const d1 = s.drones[0];
  const row1 = ui.el('fleetBody').querySelector('[data-id="' + d1.id + '"]');
  assert.ok(row1, 'Keyed row for DR-1 must exist in DOM');

  // Click on row to select (listener is attached to fleetBody via delegation)
  ui.el('fleetBody').fire('click', { target: row1 });

  // Pump UI frames to update panel
  ui.ctx.__raf.pump(200);
  ui.ctx.__raf.pump(200);

  assert.strictEqual(ui.el('killBtn').textContent, 'Kill DR-1');
  const cardHtml = ui.el('droneDecisionCard').innerHTML;
  assert.ok(cardHtml.includes('DR-1'), 'Decision card must reflect selected drone DR-1');
  assert.ok(cardHtml.includes('Mode:'), 'Decision card must show mode metric');
  assert.ok(cardHtml.includes('Battery:'), 'Decision card must show battery metric');

  // Verify keyed DOM identity: updating battery does NOT replace DOM element
  const prevRow = ui.el('fleetBody').querySelector('[data-id="' + d1.id + '"]');
  d1.energyWh = ui.ctx.usableWh(d1.af) * 0.85;
  d1.batteryPct = 85;
  ui.ctx.__raf.pump(200);
  ui.ctx.__raf.pump(200);

  const nextRow = ui.el('fleetBody').querySelector('[data-id="' + d1.id + '"]');
  assert.strictEqual(prevRow, nextRow, 'Keyed row DOM element must be preserved across updates');
  assert.strictEqual(nextRow._fpct.textContent, '85%');
});
