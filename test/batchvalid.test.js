// Findings #14/#30 (review of ffb35e6, B2/B3/B29): the batch validator
// accepted count=1.5, seeds='bad' (treated as omitted), env='toString'
// (inherited Object.prototype key — truthy, then undestructurable), null
// mission coordinates (isFinite coerces null to 0), negative sweep
// altitudes — and the work cap ignored drone count. The REST server spawned
// an unbounded worker per request with no queue, no timeout, no
// client-disconnect cancellation and no exit-without-result handling.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const B = require('../tools/batch.js');
const { createApp } = require('../tools/server.js');

const GOOD = {
  label: 't', radio: 'sik-v3', env: 'open', airframe: 'q450', terrain: 'flat',
  count: 4, durationSec: 30, seeds: [1], mission: { targetX: 400, targetY: 0 },
  sweep: [{ name: 'base' }],
};

test('regression #30: provided-but-invalid fields are rejected, not defaulted', () => {
  assert.ok(B.validateConfig({ ...GOOD, count: 1.5 }), 'fractional count accepted');
  assert.ok(B.validateConfig({ ...GOOD, seeds: 'bad' }), "seeds='bad' silently became defaults");
  assert.ok(B.validateConfig({ ...GOOD, env: 'toString' }), 'inherited object key passed as an env');
  assert.ok(B.validateConfig({ ...GOOD, mission: { targetX: null, targetY: 0 } }), 'null coordinate accepted');
  assert.ok(B.validateConfig({ ...GOOD, mission: { targetX: '500', targetY: 0 } }), 'string coordinate accepted');
  assert.ok(B.validateConfig({ ...GOOD, durationSec: '60' }), 'string duration accepted');
  assert.ok(B.validateConfig({ ...GOOD, sweep: [{ name: 'x', altitudeM: -50 }] }), 'negative sweep altitude accepted');
  assert.ok(B.validateConfig({ ...GOOD, sweep: [{ name: 'x', spacingPct: 9000 }] }), 'absurd sweep spacing accepted');
  assert.strictEqual(B.validateConfig(GOOD), null, 'the good config must stay valid');
});

test('regression #30: the work budget accounts for drone count', () => {
  // 100 runs x 1800 s is inside the old caps — but at 120 drones it is
  // days of compute, not minutes.
  const heavy = { ...GOOD, count: 120, durationSec: 1800,
    seeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    sweep: Array.from({ length: 10 }, (_, i) => ({ name: 'c' + i })) };
  assert.ok(B.validateConfig(heavy), 'a 120-drone x 100-run x 30-min sweep sailed past the work cap');
});

function post(port, body, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: '/api/batch', method: 'POST' },
      res => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve({ code: res.statusCode, body: data }));
      });
    req.on('error', reject);
    req.end(JSON.stringify(body));
    if (opts && opts.abortAfterMs) setTimeout(() => req.destroy(), opts.abortAfterMs);
    return req;
  });
}

test('regression #14: the server queues bounded work and rejects overflow with 429', async () => {
  const app = createApp({ workers: 1, queue: 1, timeoutMs: 60000 });
  await new Promise(r => app.listen(0, r));
  const port = app.address().port;
  const slow = { ...GOOD, durationSec: 120, count: 8 };
  try {
    const [a, b, c] = await Promise.all([
      post(port, slow), post(port, slow), post(port, slow),
    ]);
    const codes = [a.code, b.code, c.code].sort();
    assert.ok(codes.includes(429),
      'three simultaneous requests on a 1-worker/1-queue server must shed one, got ' + codes.join(','));
    assert.strictEqual(codes.filter(c2 => c2 === 200).length, 2, 'the other two complete');
  } finally {
    app.close();
  }
});

test('regression #14: a run that exceeds the time budget is killed with 504', async () => {
  const app = createApp({ workers: 1, queue: 2, timeoutMs: 150 });
  await new Promise(r => app.listen(0, r));
  const port = app.address().port;
  try {
    const r = await post(port, { ...GOOD, durationSec: 600, count: 20 });
    assert.strictEqual(r.code, 504, 'over-budget run must be terminated, got ' + r.code);
    assert.ok(app.batchStats.timedOut >= 1, 'the worker must actually be terminated');
  } finally {
    app.close();
  }
});

test('regression #14: a client disconnect cancels its queued/running work', async () => {
  const app = createApp({ workers: 1, queue: 2, timeoutMs: 60000 });
  await new Promise(r => app.listen(0, r));
  const port = app.address().port;
  try {
    const slow = { ...GOOD, durationSec: 900, count: 12 };
    const gone = post(port, slow, { abortAfterMs: 150 }).catch(() => 'aborted');
    await new Promise(r => setTimeout(r, 400)); // let it start, then die
    await gone;
    // wait for the cancellation to reap the worker
    for (let i = 0; i < 40 && app.batchStats.terminated < 1; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(app.batchStats.terminated >= 1,
      'an abandoned request must terminate its worker, not burn CPU to completion');
    // and the slot is actually free again: a small job completes promptly
    const t0 = Date.now();
    const r = await post(port, GOOD);
    assert.strictEqual(r.code, 200);
    assert.ok(Date.now() - t0 < 20000, 'freed slot must serve the next request promptly');
  } finally {
    app.close();
  }
});
