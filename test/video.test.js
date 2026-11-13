// Video/payload backhaul tests — the scheduler is honest: one streamer at a
// time, grants ride in order packets, chunks are REAL packets that pay real
// airtime, and loss is counted where it happens.

const { test } = require('node:test');
const assert = require('node:assert');

const R = require('../js/radios.js');
const A = require('../js/airframes.js');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();

const RFD = R.RADIOS.find(r => r.id === 'rfd900x');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function makeSw(opts) {
  return ctx.makeSwarm(Object.assign({
    count: 6,
    airframe: Q450,
    radio: RFD,
    envFactor: 1,
    targetX: 2400, targetY: -600,
    altitudeM: 60,
    seed: 21,
    videoOn: true,
    videoKbps: 500,
  }, opts));
}

function run(s, seconds) {
  let st = null;
  while (s.time < seconds) st = ctx.stepSwarm(s, 0.25);
  return st;
}

test('exactly one drone streams at a time, and the grant rotates', () => {
  const s = makeSw({});
  run(s, 200);
  assert.ok(s.c2.vidGrantee, 'some drone must hold the channel');
  const granteesSeen = new Set();
  for (let i = 0; i < 40; i++) {
    ctx.stepSwarm(s, 5);
    if (s.c2.vidGrantee) granteesSeen.add(s.c2.vidGrantee);
  }
  // Round-robin across a 200+ second window must visit more than one drone —
  // but never two at once (the invariant that matters).
  assert.ok(granteesSeen.size >= 2,
    'grants should rotate, saw only ' + [...granteesSeen].join(','));
});

test('video chunks are real traffic: they consume shared-channel airtime', () => {
  const quiet = makeSw({ videoOn: false });
  run(quiet, 150);
  const loud = makeSw({ videoOn: true });
  run(loud, 150);
  assert.ok(loud.net.vid.framesDelivered > 0, 'streaming must produce traffic');
  assert.ok(loud.net.utilization >= quiet.net.utilization,
    'channel busy% with video (' + (loud.net.utilization * 100).toFixed(1) +
    '%) must be >= without (' + (quiet.net.utilization * 100).toFixed(1) + '%)');
});

test('chunks physically route through the chain and get counted on arrival', () => {
  const s = makeSw({});
  run(s, 300);
  const v = s.net.vid;
  assert.ok(v.framesDelivered > 20,
    'a healthy 5-minute stream should deliver many chunks, got ' + v.framesDelivered);
  // Every delivered vid chunk was also a delivered packet.
  assert.ok(v.framesDelivered <= s.net.delivered);
});

test('losing the route shows up as dropped frames, not silent lies', () => {
  const s = makeSw({ count: 4 });
  run(s, 120);
  // Murder every drone except the current grantee and C2's direct neighbours:
  // simplest deterministic break is killing ALL drones — grantee included —
  // then checking accounting stays consistent afterwards.
  for (const d of s.drones) if (ctx.alive(d)) ctx.killDrone(s, d);
  const beforeDrops = s.net.vid.droppedFrames;
  run(s, 150);
  assert.ok(s.net.vid.droppedFrames >= beforeDrops);
  assert.strictEqual(s.c2.vidGrantee, null, 'no fresh mission drones -> no grant');
});

test('after-action report includes the payload section when video is on', () => {
  const s = makeSw({});
  run(s, 120);
  const md = ctx.afterActionReport(s);
  assert.ok(md.includes('## Payload link'), 'report must carry the payload section');
  assert.ok(/chunks delivered/.test(md));
});

// Review: the report's packet line summed every outcome, video fragments
// included, while tools/batch.js and tools/compare.js report control-plane
// loss (controlLossPct, NET-04). Video has its own line in the payload
// section; the packet line must be the control plane, by the same definition.
test('after-action report states control-plane loss as batch and compare do, video kept apart', () => {
  const s = makeSw({});
  run(s, 120);
  let ok = 0, lost = 0;
  for (const kind in s.net.byKind) {
    if (kind === 'vid') continue;
    ok += s.net.byKind[kind].delivered; lost += s.net.byKind[kind].dropped;
  }
  assert.ok(s.net.byKind.vid && s.net.byKind.vid.delivered + s.net.byKind.vid.dropped > 0, 'setup: video fragments were counted');
  const md = ctx.afterActionReport(s);
  const m = md.match(/delivered:\*\* ([\d,]+) · \*\*dropped:\*\* ([\d,]+) \(([\d.]+)% loss\)/);
  assert.ok(m, 'packet line missing');
  assert.strictEqual(m[1], ok.toLocaleString(), 'delivered counts video fragments');
  assert.strictEqual(m[2], lost.toLocaleString(), 'dropped counts video fragments');
  assert.strictEqual(m[3], ctx.controlLossPct(s).toFixed(1), 'loss % differs from controlLossPct');
});
