// Follow-up to f457e44 (batch API time budget). That commit sized one global
// budget from batch.js's cost rates, which batch.js itself says are stale, so a
// batch the limits admit could still be killed. The budget now follows each
// request's own measured pace: the worker reports progress, and the server
// re-arms the kill timer from elapsed/fraction. The stale rate is used only
// before the first progress report. These tests pin that behaviour.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const B = require('../tools/batch.js');
const S = require('../tools/server.js');

const GOOD = {
  label: 't', radio: 'sik-v3', env: 'open', airframe: 'q450', terrain: 'flat',
  count: 4, durationSec: 30, seeds: [1], mission: { targetX: 400, targetY: 0 },
  sweep: [{ name: 'base' }],
};
const STUB = path.join(__dirname, 'helpers', 'stubbatch.js');

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: '/api/batch', method: 'POST' }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function withApp(opts, fn) {
  const app = S.createApp(opts);
  await new Promise(r => app.listen(0, r));
  try { return await fn(app.address().port, app); } finally { app.close(); }
}

test('the per-request estimate and the validator read one cost model', () => {
  const cost = B.batchCost(GOOD);
  assert.strictEqual(B.estimateWallMs(GOOD), cost.work * 1 + cost.planWork * 0.012);
  assert.ok(B.estimateWallMs(GOOD) <= B.maxBatchWallMs());

  // The workload the validator rejects is the workload the estimate counts.
  const heavy = { ...GOOD, count: 120, durationSec: 1800, seeds: [1, 2, 3] };
  const hc = B.batchCost(heavy);
  assert.ok(hc.work > B.LIMITS.maxTotalWorkDroneSec, 'fixture must exceed the work cap');
  assert.ok((B.validateConfig(heavy) || '').includes('(' + hc.work + ' jammer-weighted'),
    'validator and estimate disagree on the work: ' + B.validateConfig(heavy));

  // Jammers weight the estimate, as they weight the budgets.
  const jam = n => Array.from({ length: n }, (_, i) => ({ x: 100 + i, y: 0, erpDbm: 20 }));
  const jammed = { ...GOOD, features: { jammers: jam(8) } };
  assert.strictEqual(B.batchCost(jammed).work, 2 * B.batchCost(GOOD).work);
  assert.ok(B.estimateWallMs(jammed) > B.estimateWallMs(GOOD));
});

test('batchBudgetMs: the static estimate only sets the budget until progress arrives', () => {
  const policy = { margin: 2, floorMs: 300000, ceilingMs: 2160000 };
  const f = S.batchBudgetMs;
  // Before any progress: margin x estimate, clamped to [floor, ceiling].
  assert.strictEqual(f({ estimateMs: 1000, elapsedMs: 5000, fraction: 0 }, policy), 300000);
  assert.strictEqual(f({ estimateMs: 600000, elapsedMs: 0, fraction: 0 }, policy), 1200000);
  assert.strictEqual(f({ estimateMs: 5e6, elapsedMs: 0, fraction: 0 }, policy), 2160000);
  // With progress: margin x the projected total at the request's own pace, and
  // the (stale) estimate no longer matters.
  const a = f({ estimateMs: 1, elapsedMs: 400000, fraction: 0.5 }, policy);
  const b = f({ estimateMs: 9e9, elapsedMs: 400000, fraction: 0.5 }, policy);
  assert.strictEqual(a, 1600000);
  assert.strictEqual(a, b);
  // A request running 35x slower than another gets 35x the budget, until the ceiling.
  const fast = f({ estimateMs: 1, elapsedMs: 20000, fraction: 0.1 }, { ...policy, floorMs: 1 });
  const slow = f({ estimateMs: 1, elapsedMs: 700000, fraction: 0.1 }, { ...policy, floorMs: 1, ceilingMs: 1e9 });
  assert.strictEqual(slow / fast, 35);
  // Never above the ceiling, never below the floor, fraction > 1 counts as done.
  assert.strictEqual(f({ estimateMs: 1, elapsedMs: 1e6, fraction: 0.1 }, policy), 2160000);
  assert.strictEqual(f({ estimateMs: 1, elapsedMs: 10, fraction: 1.5 }, policy), 300000);
  // A missing or garbled input falls back to the floor: setTimeout(NaN) would fire at once.
  assert.strictEqual(f({ elapsedMs: 5, fraction: 0 }, policy), 300000);
  assert.strictEqual(f({ estimateMs: NaN, elapsedMs: NaN, fraction: 0.3 }, policy), 300000);
});

test('batchDeadlineMs: after any report a batch gets at least the floor of silence, within the ceiling', () => {
  const policy = { margin: 2, floorMs: 300000, ceilingMs: 2160000 };
  const d = S.batchDeadlineMs;
  // Mid-batch, mostly done, 160 s old: the pace budget (2 x 160/0.9 = 355 s)
  // would leave only 195 s of silence; the floor guarantees 300 s.
  assert.strictEqual(d({ estimateMs: 1, elapsedMs: 160000, fraction: 0.9 }, policy), 460000);
  // Once the pace budget leaves more than the floor, the pace budget rules.
  assert.strictEqual(d({ estimateMs: 1, elapsedMs: 400000, fraction: 0.5 }, policy), 1600000);
  // Before any report the deadline is the static budget (never under the floor).
  assert.strictEqual(d({ estimateMs: 600000, elapsedMs: 0, fraction: 0 }, policy), 1200000);
  assert.strictEqual(d({ estimateMs: 1, elapsedMs: 0, fraction: 0 }, policy), 300000);
  // The ceiling still bounds the total, however old the batch.
  assert.strictEqual(d({ estimateMs: 1, elapsedMs: 2000000, fraction: 0.9 }, policy), 2160000);
});

test('runBatch gives the same results with and without a heartbeat, and the heartbeat is monotonic', () => {
  const cfg = { ...GOOD, durationSec: 60, seeds: [1, 2] };
  const plain = B.runBatch(cfg);
  const beats = [];
  const watched = B.runBatch(cfg, null, f => beats.push(f));
  assert.deepStrictEqual(watched, plain);
  assert.ok(beats.length >= 20, 'two 60 s runs beat about every 5 sim-s, got ' + beats.length);
  for (let i = 0; i < beats.length; i++) {
    assert.ok(beats[i] > 0 && beats[i] <= 1, 'fraction out of range: ' + beats[i]);
    if (i) assert.ok(beats[i] >= beats[i - 1], 'fraction went backwards at ' + i);
  }
});

test('a batch that keeps reporting progress outlives the floor; one that stalls is killed with a message that says so', async () => {
  await withApp({ workers: 1, queue: 1, floorMs: 1000, ceilingMs: 60000, workerBatchPath: STUB }, async port => {
    const t0 = Date.now();
    const steady = await post(port, { ...GOOD, label: 'steady' });
    assert.strictEqual(steady.code, 200, steady.body);
    assert.ok(Date.now() - t0 > 1000, 'premise: the steady job runs past the 1000 ms floor');

    const stall = await post(port, { ...GOOD, label: 'stall' });
    assert.strictEqual(stall.code, 504);
    const msg = JSON.parse(stall.body).error;
    assert.match(msg, /stopped making progress/);
    assert.match(msg, /50% done/);
    assert.match(msg, /fewer runs.*tools\/batch\.js/);
  });
});

test('a batch over the ceiling is killed at the ceiling even while it reports progress', async () => {
  await withApp({ workers: 1, queue: 1, floorMs: 700, ceilingMs: 700, workerBatchPath: STUB }, async (port, app) => {
    assert.strictEqual(app.batchTimeoutMs, 700);
    const r = await post(port, { ...GOOD, label: 'steady' });
    assert.strictEqual(r.code, 504);
    assert.match(JSON.parse(r.body).error, /700 ms limit the server gives any batch.*fewer runs.*tools\/batch\.js/);
  });
});

test('real batches still complete through the worker, heartbeats and all', async () => {
  await withApp({ workers: 1, queue: 1 }, async (port, app) => {
    assert.ok(app.batchTimeoutMs >= 2 * B.maxBatchWallMs(), 'the default ceiling still covers the largest admissible batch');
    const r = await post(port, { ...GOOD, durationSec: 60, seeds: [1, 2] });
    assert.strictEqual(r.code, 200, r.body);
    assert.strictEqual(JSON.parse(r.body).runs, 2);
  });
});
