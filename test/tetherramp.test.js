// Regression for #18 (tether half): at the stop floor the tether's goal jumped
// from "hold here" (the slow band's throttle reaches zero at the floor) to
// "40% of the way back to the upstream node" — a step of tens to hundreds of
// metres for an infinitesimal change in margin. Fading around the floor made
// drones lurch back and forth (UI defaults: ~75 m lurch pairs ~2.5 s apart; a
// jammed relay-wing hop oscillated +/-300 m along the corridor).

const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

// One drone 250 m out, hanging off C2, trying to fly further out to x=800.
function drone() {
  const ctx = loadCore();
  const s = ctx.makeSwarm({
    count: 1, seed: 5, envFactor: 1, altitudeM: 50, targetX: 800, targetY: 0,
    radio: R.RADIOS.find(r => r.id === 'sik-v3'), airframe: A.AIRFRAMES.find(a => a.id === 'q450'),
  });
  const d = s.drones[0];
  d.x = d.belX = 250; d.y = d.belY = 0; d.vx = d.vy = 0;
  const stopDb = ctx.plannedHopMarginDb(s, d) - ctx.consts.TETHER.stopBelowPlanDb;
  const outbound = { x: 800, y: 0 };
  const goalAt = m => { d.upMarginEma = m; return ctx.tetherGoal(s, d, outbound); };
  return { d, stopDb, goalAt };
}

test('#18: the tether goal has no step at the stop floor', () => {
  const { stopDb, goalAt } = drone();
  const above = goalAt(stopDb + 0.001), below = goalAt(stopDb - 0.001);
  const jump = Math.hypot(above.x - below.x, above.y - below.y);
  assert.ok(jump < 1, `0.002 dB across the stop floor moved the goal ${jump.toFixed(1)} m`);
});

test('#18: far below the floor the tether still closes 40% of the gap (guard)', () => {
  const { d, stopDb, goalAt } = drone();
  const g = goalAt(stopDb - 5);
  assert.ok(Math.abs(g.x - d.x * 0.6) < 1e-6 && Math.abs(g.y) < 1e-6,
    `expected the goal 40% of the way back to C2 (x=${(d.x * 0.6).toFixed(1)}), got ${g.x.toFixed(1)}`);
  assert.ok(d.tethered, 'closing up must still flag the drone as tethered');
});
