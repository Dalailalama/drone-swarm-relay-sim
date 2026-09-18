// Finding #18 (review of ffb35e6, B19): onboard decisions and logs read
// LIVE truth the vehicle cannot know —
//  * GPS-denied black-box samples recorded ~the TRUE position (reviewer:
//    belief (1000,1000), truth (100,100), logged (99.59, 97.24));
//  * return/relink goals aimed at the CURRENT base position even while
//    fully disconnected — teleport the operator and a link-dead drone
//    magically follows.
// Drones log their nav BELIEF, and steer home to where they last LEARNED
// the base was (spawn briefing, updated by every received C2 packet).
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

test('F11: tether learns upstream position only through delivered telemetry and orders', () => {
  const s = mk();
  const [d, up] = s.drones;
  d.x = 100; d.y = 0;
  up.x = 0; up.y = 0;
  d.order.upstream = up.id;
  d.upMarginEma = -20;
  const receive = (x, at) => {
    d.inbox.push({ kind: 'cmd', src: 'C2', payload: {
      ...d.order, upstreamPos: { x, y: 0, at }, c2: { x: 0, y: 0, at },
    } });
    d.nextTlm = Infinity;
    ctx.droneComms(s, d);
  };
  receive(0, 0);
  const before = ctx.tetherGoal(s, d, { x: 200, y: 0 });
  assert.strictEqual(before.x, 60);
  up.x = -1000;
  assert.deepStrictEqual(ctx.tetherGoal(s, d, { x: 200, y: 0 }), before);
  s.time = 1;
  receive(-1000, 1);
  assert.strictEqual(ctx.tetherGoal(s, d, { x: 200, y: 0 }).x, -340);
  receive(0, 0);
  assert.strictEqual(ctx.tetherGoal(s, d, { x: 200, y: 0 }).x, -340);
});

test('F11: missing or stale upstream observations hold a weak-link drone in place', () => {
  const s = mk();
  const d = s.drones[0];
  d.x = 100; d.y = 0; d.upMarginEma = -20;
  d.order.upstream = s.drones[1].id;
  assert.strictEqual(ctx.tetherGoal(s, d, { x: 200, y: 0 }).x, 100);
  d.neighborKnown[d.order.upstream] = { x: 0, y: 0, at: 0 };
  s.time = 100;
  assert.strictEqual(ctx.tetherGoal(s, d, { x: 200, y: 0 }).x, 100);
  d.order.upstream = 'C2';
  s.base.x = -1000;
  assert.strictEqual(ctx.tetherGoal(s, d, { x: 200, y: 0 }).x, 100);
});

for (const broadcastC2 of [false, true]) {
  test('F11: timestamped upstream observations traverse telemetry and ' + (broadcastC2 ? 'broadcast' : 'unicast'), () => {
    const s = mk();
    const [d, up] = s.drones;
    s.broadcastC2 = broadcastC2;
    s.c2.nextCmd = Infinity;
    d.x = 100; d.y = 0; up.x = 0; up.y = 0;
    up.gpsDenied = true; up.belX = 0; up.belY = 0;
    d.nextTlm = up.nextTlm = 0;
    ctx.droneComms(s, d);
    ctx.droneComms(s, up);
    d.nextTlm = up.nextTlm = Infinity;
    up.x = -200;
    const network = () => {
      for (let i = 0; i < 80; i++) { s.time += 0.05; ctx.stepNet(s, 0.05); }
    };
    network();
    ctx.c2Step(s);
    assert.strictEqual(s.c2.known[up.id].x, 0);
    assert.strictEqual(s.c2.known[up.id].posAt, 0);
    s.c2.relays = [up.id];
    s.c2.nextCmd = 0;
    ctx.c2Step(s);
    assert.strictEqual(d.neighborKnown[up.id], undefined);
    network();
    ctx.droneComms(s, d);
    assert.strictEqual(d.order.upstream, up.id);
    assert.strictEqual(d.neighborKnown[up.id].x, 0);
    assert.strictEqual(d.neighborKnown[up.id].at, 0);
    assert.ok(d.neighborKnown[up.id].receivedAt > 0);
    d.upMarginEma = -20;
    assert.strictEqual(ctx.tetherGoal(s, d, { x: 200, y: 0 }).x, 60);
  });
}

function mk() {
  return ctx.makeSwarm({
    count: 2, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  });
}

test('regression #18: GPS-denied black-box samples record the BELIEF, not truth', () => {
  const s = mk();
  const d = s.drones[0];
  d.gpsDenied = true;
  d.belX = 1000; d.belY = 1000; // dead-reckoning estimate, far from truth
  d.x = 100; d.y = 100;
  d.mode = 'hold';
  d.nextDeadLog = 0;
  ctx.stepSwarm(s, 0.05);
  assert.ok(d.deadLog.length >= 1, 'a silent drone must log');
  const p = d.deadLog[d.deadLog.length - 1];
  const toBelief = Math.hypot(p.x - 1000, p.y - 1000);
  const toTruth = Math.hypot(p.x - 100, p.y - 100);
  assert.ok(toBelief < 60 && toTruth > 500,
    'black box recorded (' + p.x.toFixed(1) + ', ' + p.y.toFixed(1) + ') — the truth it cannot know');
});

test('regression #18: a returning drone flies to where it LAST KNEW the base', () => {
  const s = mk();
  const d = s.drones[0];
  d.x = 600; d.y = 0; d.vx = 0; d.vy = 0;
  d.mode = 'rtb'; // returning — and by design not processing comms
  s.base.x = 0; s.base.y = 5000; // operator teleports while the drone is deaf
  for (let i = 0; i < 40; i++) ctx.stepSwarm(s, 0.05);
  assert.ok(Math.abs(d.goalY) < 500,
    'a drone that never heard about the move steered to the new base anyway (goalY=' +
    (d.goalY == null ? 'null' : d.goalY.toFixed(0)) + ')');
});

test('a received C2 packet teaches the drone the new base position (guard)', () => {
  const s = mk();
  const d = s.drones[0];
  // Within link range of the relocated base, so the tether doesn't fight
  // the return leg — this guard tests the KNOWLEDGE, not tether physics.
  d.x = 0; d.y = 4800;
  s.base.x = 0; s.base.y = 5000;
  // A broadcast physically arrives carrying C2's position…
  d.inbox.push({ kind: 'bcast', src: 'C2', payload: { seq: 99, orders: {}, c2: { x: 0, y: 5000 } } });
  ctx.stepSwarm(s, 0.05);
  assert.ok(d.baseKnown && Math.abs(d.baseKnown.y - 5000) < 1,
    'the packet must update the drone\'s base knowledge');
  // …and a subsequent return flies to the LEARNED position.
  d.mode = 'rtb';
  for (let i = 0; i < 10; i++) ctx.stepSwarm(s, 0.05);
  assert.ok(d.goalY > 3000,
    'after hearing from C2, home is the real base (goalY=' + (d.goalY == null ? 'null' : d.goalY.toFixed(0)) + ')');
});
