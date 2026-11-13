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

  // 8. Landed mode (at base, the crew swapping the pack)
  d.mode = 'landed';
  d.swapAt = s.time + 90;
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

// Audit finding ui-render/landed-drone-shown-as-down: the card was gated on
// alive(), which is false for a drone landed for a battery swap, so a landed
// drone was reported in red as "is down (destroyed or battery exhausted)".
test('a drone landed for a swap is shown as landed, not as down', () => {
  const ui = loadUI();
  const s = ui.ctx.sim.swarm;
  ui.ctx.__raf.pump(200);
  ui.ctx.__raf.pump(200);
  const d = s.drones[1];
  ui.el('fleetBody').fire('click', { target: ui.el('fleetBody').querySelector('[data-id="' + d.id + '"]') });
  d.mode = 'landed';
  d.swapAt = s.time + 1e6;
  ui.ctx.__raf.pump(200);
  ui.ctx.__raf.pump(200);
  const card = ui.el('droneDecisionCard').innerHTML;
  assert.ok(card.includes('Landed on base pad'), card);
  assert.ok(!card.includes('is down'), card);
  d.mode = 'dead';
  ui.ctx.__raf.pump(200);
  ui.ctx.__raf.pump(200);
  assert.ok(ui.el('droneDecisionCard').innerHTML.includes('is down'));
});

// The card explains the drone's own RTB call, which prices the home leg from
// its nav belief (audit EN-8). Priced from truth, a GNSS-denied drone that
// turned for home was explained as needing less than half the energy it had.
test('the RTB explanation prices the home leg from the nav belief the drone decided on', () => {
  const ctx = loadCore();
  const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
  const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');
  const s = ctx.makeSwarm({ count: 1, seed: 101, radio: SIK, airframe: Q450, targetX: 3000, targetY: 0 });
  const d = s.drones[0];
  d.x = 100; d.y = 0; d.belX = 3000; d.belY = 0; d.gpsDenied = true; // truth near home, belief 3 km out
  const pw = A.flightPowerW(Q450, Q450.maxSpeedMs);
  d.energyWh = A.usableWh(Q450) * 0.07 + pw * (1500 / Q450.maxSpeedMs) / 3600 * 1.3; // between the two home legs
  ctx.updateBattery(s, d, 0.05, 0);
  assert.strictEqual(d.mode, 'rtb', 'setup: the drone turns for home on its belief');
  const exp = ctx.explainDroneDecision(s, d);
  assert.ok(exp.requiredWh >= d.energyWh,
    'the card says it needs ' + exp.requiredWh.toFixed(1) + ' Wh with ' + d.energyWh.toFixed(1) + ' Wh left, yet it turned for home');
});

// A drone holds after 3 order rounds of silence at the cadence C2 announced
// (never under FAILSAFE.holdSec); on a slow link that is far past 8 s.
test('the hold explanation quotes the silence threshold the drone actually holds at', () => {
  const ctx = loadCore();
  const s = ctx.makeSwarm({ count: 1, seed: 101, radio: R.RADIOS[0], airframe: A.AIRFRAMES[0] });
  const d = s.drones[0];
  d.linkCadence = { tlmSec: 30, cmdSec: 40 }; // a slow link: one order round every 40 s
  s.time = 300;
  d.lastC2 = s.time - 100;
  ctx.droneComms(s, d);
  assert.strictEqual(d.mode, 'ok', 'setup: 100 s is inside the 120 s tolerance');
  d.lastC2 = s.time - 125;
  ctx.droneComms(s, d);
  assert.strictEqual(d.mode, 'hold', 'setup: 125 s is past it');
  const exp = ctx.explainDroneDecision(s, d);
  assert.ok(/threshold 120(\.0)?\s?s/.test(exp.summary), exp.summary);
});

// A drone that set down at a stale last-known home has no crew to swap it
// and never relaunches (ONB-01); the card must not promise a swap.
test('a drone landed at a stale home is not explained as swapping on the base pad', () => {
  const ctx = loadCore();
  const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
  const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');
  const s = ctx.makeSwarm({ count: 1, seed: 42, radio: SIK, airframe: Q450, targetX: 600, targetY: 0 });
  const d = s.drones[0];
  s.c2.nextCmd = Infinity;
  d.x = d.belX = 1500; d.y = d.belY = 0; d.vx = d.vy = 0;
  d.mode = 'rtb';
  s.base.x = 0; s.base.y = 3000; // operator relocates while the drone is deaf
  while (s.time < 600 && d.mode === 'rtb') ctx.stepSwarm(s, 0.05);
  assert.strictEqual(d.mode, 'landed', 'setup');
  assert.strictEqual(d.swapAt, null, 'setup: no crew at the stale home');
  const exp = ctx.explainDroneDecision(s, d);
  assert.ok(!/swapping|base pad/.test(exp.summary), exp.summary);
});
