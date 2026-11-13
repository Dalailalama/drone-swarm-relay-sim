// Black-box samples logged without a GNSS fix (review). The black box
// records where the drone BELIEVES it is (finding #18), and GNSS-denied that
// is dead reckoning that can sit cells away from where the silence really
// was. C2 painted every uploaded sample RF-bad at weight 3 — the poisoning
// C2-08 already removed for live reports, which C2 skips when the drone says
// gps:'denied'. Each sample must carry the same flag, and C2 must treat a
// flagged sample the way it treats a denied live report: ACKed, never painted.
const { test } = require('node:test');
const assert = require('node:assert');
const { loadCore } = require('./helpers/sim.js');
const ctx = loadCore();
const R = require('../js/radios.js');
const A = require('../js/airframes.js');

const SIK = R.RADIOS.find(r => r.id === 'sik-v3');
const Q450 = A.AIRFRAMES.find(a => a.id === 'q450');

function mk(extra) {
  return ctx.makeSwarm(Object.assign({
    count: 2, airframe: Q450, radio: SIK, envFactor: 1,
    targetX: 600, targetY: 0, altitudeM: 50, seed: 42,
  }, extra));
}

function badWeightAt(s, x, y) {
  const key = Math.floor(x / s.covCellM) + ',' + Math.floor(y / s.covCellM);
  const e = s.c2.cov.get(key);
  return e ? e.bad : 0;
}

test('a black-box sample logged GNSS-denied is flagged, uploaded flagged, ACKed, and not painted RF-bad', () => {
  const s = mk({ gpsZones: [{ id: 'GZ-1', x: 0, y: 0, rM: 5000, on: true }] });
  const d = s.drones[0];
  s.c2.nextCmd = Infinity; // C2 stays silent: nothing pulls the drone out of hold
  ctx.stepSwarm(s, 0.05);
  assert.ok(d.gpsDenied, 'the drone must know it has no fix');
  d.belX = 1000; d.belY = 1000; // dead reckoning, far from the truth
  d.mode = 'hold'; d.holdX = 1000; d.holdY = 1000; d.lastC2 = s.time;
  d.nextDeadLog = 0;
  ctx.stepSwarm(s, 0.05);
  assert.strictEqual(d.deadLog.length, 1, 'a silent drone must log');
  assert.strictEqual(d.deadLog[0].gps, 'denied', 'the sample must say it was logged without a fix');

  s.net.nodeTxUntil[d.id] = 50; // keep the upload queued so we can inspect it
  d.nextTlm = 0;
  ctx.stepSwarm(s, 0.05);
  const tlm = s.net.packets.find(p => p.kind === 'tlm' && p.src === d.id && p.payload && p.payload.deadLog);
  assert.ok(tlm, 'telemetry with the sample must be queued');
  assert.deepStrictEqual([...tlm.payload.deadLog].map(r => r.gps), ['denied'], 'the flag must ride in the upload');

  // A mixed upload: the flagged sample plus one logged with a fix.
  const rows = [...tlm.payload.deadLog, { x: 300, y: 300, seq: 99, gps: 'ok' }];
  const before = badWeightAt(s, rows[0].x, rows[0].y);
  s.net.packets.length = 0;
  s.c2.inbox.push({ kind: 'tlm', src: d.id, dst: 'C2', payload: { ...tlm.payload, deadLog: rows } });
  ctx.stepSwarm(s, 0.05);
  assert.strictEqual(badWeightAt(s, rows[0].x, rows[0].y), before,
    'C2 painted a dead-reckoned sample RF-bad at (' + rows[0].x.toFixed(0) + ', ' + rows[0].y.toFixed(0) + ')');
  assert.strictEqual(badWeightAt(s, 300, 300), 3, 'a sample logged with a fix is still evidence');
  const ack = s.net.packets.find(p => p.kind === 'ack' && p.dst === d.id) ||
    d.inbox.find(p => p.kind === 'ack');
  assert.ok(ack, 'the upload must be ACKed');
  assert.deepStrictEqual([...ack.payload.ackDeadLogSeqs].sort((a, b) => a - b), [rows[0].seq, 99].sort((a, b) => a - b),
    'the flagged sample must be ACKed too, so the drone stops re-sending it');
});
