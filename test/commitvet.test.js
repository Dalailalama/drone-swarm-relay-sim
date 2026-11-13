// Audit C2-06: the commitment rule declined a NEW tasking whose recovery
// plan did not close and "kept flying the current (previously vetted)
// order", but the current order was often never vetted at all: the preflight
// mission order and C2's first mission order share a signature, so the gate
// never ran on it. On a 12 km LoRa mission every drone declined the nearer,
// cheaper relay slot and kept flying the farther, equally non-closing mission.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const LORA = R.RADIOS.find(r => r.id === 'lora868');
const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function deliver(s, d, order) {
  d.inbox.push({ kind: 'cmd', src: 'C2', dst: d.id, payload: order });
  ctx.droneComms(s, d);
}

function relayOrder(s, x, y) {
  return { role: 'relay', slot: 0, k: 1, upstream: 'C2', slotPos: { x, y },
    c2: { x: s.base.x, y: s.base.y, at: s.time }, target: { x: s.target.x, y: s.target.y } };
}

test('C2-06: a drone on a non-closing order takes a cheaper new tasking instead of declining it', () => {
  const s = ctx.makeSwarm({ count: 4, airframe: Q450, radio: SIK, envFactor: 1, targetX: 12000, targetY: 0, seed: 3 });
  const d = s.drones[0];
  s.time = 1;
  assert.strictEqual(ctx.orderFeasible(s, d, d.order), false, 'the 12 km preflight mission must not close');
  const relay = relayOrder(s, 3000, 0);
  // Low enough that the 3 km slot does not close either: both fail the gate.
  d.energyWh = ctx.usableWh(Q450) * 0.35;
  assert.strictEqual(ctx.orderFeasible(s, d, relay), false, 'the relay slot must not close either');
  deliver(s, d, relay);
  assert.strictEqual(d.order.role, 'relay', 'declined the nearer slot to keep flying a farther non-closing mission');
});

test('C2-06: a drone on an order that closes still declines one that does not (guard)', () => {
  const s = ctx.makeSwarm({ count: 4, airframe: Q450, radio: SIK, envFactor: 1, targetX: 300, targetY: 0, seed: 3 });
  const d = s.drones[0];
  s.time = 1;
  assert.strictEqual(ctx.orderFeasible(s, d, d.order), true);
  deliver(s, d, relayOrder(s, 20000, 0));
  assert.strictEqual(d.order.role, 'mission', 'a vetted order must win over one that does not close');
  assert.strictEqual(d.rejectedRole, 'relay');
});

test('C2-06: on a 12 km LoRa mission no drone declines a cheaper tasking while flying one that does not close', () => {
  const s = ctx.makeSwarm({ count: 10, airframe: Q450, radio: LORA, envFactor: 1, targetX: 12000, targetY: 0, seed: 3,
    terrain: ctx.makeTerrain('rolling', { distM: 12000, altM: 50, baseX: 0, baseY: 0, targetX: 12000, targetY: 0, seed: 3 }) });
  const inversions = [];
  const lastSig = {};
  while (s.time < 90) {
    ctx.stepSwarm(s, 0.25);
    for (const d of s.drones) {
      if (d.rejectedSig && d.rejectedSig !== lastSig[d.id] && !ctx.orderFeasible(s, d, d.order)) {
        // No wind: the backup plan's energy is proportional to out + home distance.
        const [gx, gy] = d.rejectedSig.split('/')[1].split(',').map(Number);
        const here = { x: d.belX, y: d.belY }, home = d.baseKnown;
        const cost = g => Math.hypot(g.x - here.x, g.y - here.y) + Math.hypot(home.x - g.x, home.y - g.y);
        if (cost({ x: gx, y: gy }) < cost(ctx.orderGoal(s, d.order))) {
          inversions.push('t=' + s.time.toFixed(1) + ' ' + d.id + ' declined ' + d.rejectedSig + ' while flying a farther ' + d.order.role);
        }
      }
      lastSig[d.id] = d.rejectedSig;
    }
  }
  assert.strictEqual(inversions.length, 0, inversions.join('; '));
});
