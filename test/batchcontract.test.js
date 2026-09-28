// Soak-audit findings R2/R8, R4 and R13 (issue #24) — batch API contract.
//  R8:  the work budget counted only drone-seconds. count=1 x 30 s (30 of
//       600000) with a legal 100 km objective on a short-range radio made
//       every C2 replan search a ~3M-cell grid (~1 min each, every 5 sim-s):
//       the request held a worker until the 5-min timeout (504).
//  R4:  videoKbps up to 100000 fragmented every chunk into thousands of
//       256-byte packets; the UI's own maximum is 2000 kbps.
//  R13: an oversize body got a TCP reset instead of an HTTP error; unknown
//       top-level / sweep-cell / mission keys were silently ignored (a
//       different experiment ran than the one requested); the CLI printed
//       raw stack traces, crashed on a `null` config before validating it,
//       and crashed AFTER the run when --out named an existing file.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const B = require('../tools/batch.js');
const { createApp } = require('../tools/server.js');

const GOOD = { label: 't', radio: 'sik-v3', env: 'open', airframe: 'q450', terrain: 'flat',
  count: 2, durationSec: 30, seeds: [1], mission: { targetX: 400, targetY: 0 } };

test('R8: a far objective is budgeted by its planning cost, not just drone-seconds', () => {
  const far = { ...GOOD, env: 'urban', count: 1, mission: { targetX: 80000, targetY: 60000 } };
  assert.match(B.validateConfig(far) || '', /plan/i, 'a 100 km short-radio mission sailed through a 30 drone-second budget');
  // A long radio makes the same geometry cheap: the planner's grid scales with hop range.
  assert.strictEqual(B.validateConfig({ ...far, radio: 'rfd900x' }), null);
  // Medium span: fine for a short run, over budget when repeated for 30 min x many seeds.
  const mid = { ...GOOD, env: 'urban', count: 1, mission: { targetX: 16000, targetY: 12000 } };
  assert.strictEqual(B.validateConfig(mid), null, 'a 20 km / 30 s single run must stay allowed');
  assert.match(B.validateConfig({ ...mid, durationSec: 1800, seeds: [1, 2, 3] }) || '', /plan/i);
  // Everyday configs are untouched.
  assert.strictEqual(B.validateConfig(GOOD), null);
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '../batch/example.json'), 'utf8'));
  assert.strictEqual(B.validateConfig(example), null);
});

test('R4: videoKbps is capped at the UI maximum', () => {
  assert.strictEqual(B.validateConfig({ ...GOOD, features: { videoOn: true, videoKbps: 2000 } }), null);
  for (const v of [2001, 20000, 100000]) {
    assert.match(B.validateConfig({ ...GOOD, features: { videoOn: true, videoKbps: v } }) || '', /videoKbps/);
  }
});

test('R13: fields the engine does not read are rejected, not silently ignored', () => {
  assert.match(B.validateConfig({ ...GOOD, windSpd: 15 }) || '', /windSpd/);
  assert.match(B.validateConfig({ ...GOOD, sweep: [{ name: 'big', count: 100 }] }) || '', /count/);
  assert.match(B.validateConfig({ ...GOOD, mission: { targetX: 400, targetY: 0, baseX: 5 } }) || '', /baseX/);
  assert.match(B.validateConfig(JSON.parse('{"__proto__":{"x":1},' + JSON.stringify(GOOD).slice(1))) || '', /__proto__/);
  assert.match(B.validateConfig({ ...GOOD, label: { a: 1 } }) || '', /label/);
});

test('R13: an oversize request body gets 413, not a connection reset', async () => {
  const app = createApp({ workers: 1, queue: 1, timeoutMs: 60000 });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  try {
    const res = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: app.address().port, method: 'POST', path: '/api/batch' }, r => {
        let d = ''; r.on('data', c => { d += c; }); r.on('end', () => resolve({ code: r.statusCode, body: d }));
      });
      rq.on('error', reject);
      rq.end(JSON.stringify({ ...GOOD, label: 'x'.repeat(300 * 1024) }));
    });
    assert.strictEqual(res.code, 413);
    assert.match(JSON.parse(res.body).error, /exceeds/);
    assert.strictEqual(app.batchStats.peak, 0, 'nothing may run');
  } finally {
    await new Promise(r => app.close(r));
  }
});

test('R13: the CLI fails with one clear line (no stack) and never writes on bad input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-cli-'));
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, '../tools/batch.js'), ...args], { cwd: dir, encoding: 'utf8', timeout: 20000 });
  try {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{"radio":');
    fs.writeFileSync(path.join(dir, 'null.json'), 'null');
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(GOOD));
    fs.writeFileSync(path.join(dir, 'afile'), 'not a directory');
    const cases = [
      [['--config', 'missing.json'], /cannot read config/],
      [['--config', 'broken.json'], /not valid JSON/],
      [['--config', 'null.json'], /invalid config: config must be a JSON object/],
      [['--config', 'good.json', '--out', 'afile'], /not a directory/],
    ];
    for (const [args, re] of cases) {
      const r = cli(...args);
      assert.strictEqual(r.status, 1, args.join(' ') + ' -> exit ' + r.status);
      assert.match(r.stderr, re, args.join(' ') + ': ' + r.stderr);
      assert.ok(!/\n\s+at /.test(r.stderr), 'no stack trace for ' + args.join(' ') + ':\n' + r.stderr);
    }
    assert.strictEqual(fs.readFileSync(path.join(dir, 'afile'), 'utf8'), 'not a directory');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['afile', 'broken.json', 'good.json', 'null.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
