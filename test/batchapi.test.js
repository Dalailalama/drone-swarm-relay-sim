// Batch REST API tests — spin the real zero-dep HTTP app on an ephemeral
// port and exercise health, schema, a real batch POST, and error paths.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createApp } = require('../tools/server.js');

let server, base;

test.before(async () => {
  server = createApp();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => new Promise(resolve => server.close(resolve)));

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data), text: data }));
    });
    r.on('error', reject);
    if (body) r.end(JSON.stringify(body)); else r.end();
  });
}

test('health reports ok with the guardrail limits', async () => {
  const r = await req('GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json().ok, true);
  assert.ok(r.json().limits.maxTotalRuns >= 1);
});

test('schema documents the contract', async () => {
  const r = await req('GET', '/api/schema');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json().POST, '/api/batch');
});

test('POST /api/batch returns distributions over seeds', async () => {
  const cfg = {
    label: 'api smoke',
    radio: 'rfd900x', env: 'open', airframe: 'q450', terrain: 'flat',
    count: 6, durationSec: 60, seeds: [21, 22],
    mission: { targetX: 1800, targetY: -400 },
    features: { videoOn: true, videoKbps: 250 },
    sweep: [{ name: 'base' }],
  };
  const r = await req('POST', '/api/batch', cfg);
  assert.strictEqual(r.status, 200);
  const j = r.json();
  assert.strictEqual(j.runs, 2);
  assert.ok(j.summary.length === 1);
  assert.ok(j.summary[0].uptime.mean >= 0);
  assert.ok(j.md.includes('Monte Carlo batch report'));
  assert.ok(j.csv.startsWith('cell,seed'));
});

test('invalid configs get 422 with a human reason; junk gets 400', async () => {
  const bad = await req('POST', '/api/batch', { radio: 'nope', env: 'open', mission: { targetX: 0, targetY: 0 } });
  assert.strictEqual(bad.status, 422);
  assert.ok(bad.json().error.includes('unknown radio'));
  const junk = await new Promise((resolve, reject) => {
    const rq = http.request(base + '/api/batch', { method: 'POST' }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    rq.on('error', reject);
    rq.end('{not json');
  });
  assert.strictEqual(junk.status, 400);
});

test('unknown paths 404', async () => {
  const r = await req('GET', '/api/nothing');
  assert.strictEqual(r.status, 404);
});
